'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const garage = require('../lib/garage');

const uuid = 'garage-uuid';
const accountId = 'account-1';
const endpointId = `${uuid}:0`;
const descriptor = () => garage.pairingDevice(accountId, { id: endpointId, name: 'Garage', model: 'msg100', classHint: 'cover', traits: ['cover', 'system'] }, { uuid, name: 'Garage', model: 'MSG100' });
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function loadHomey(relative, homey) {
    const filename = path.join(__dirname, '..', relative);
    const result = { exports: {} };
    const scopedRequire = name => name === 'homey' ? homey : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: scopedRequire, module: result, exports: result.exports }, { filename });
    return result.exports;
}

function pairingSession() {
    const handlers = new Map();
    return { handlers, setHandler(name, handler) { handlers.set(name, handler); }, emit(name, value) { return handlers.get(name)(value); } };
}

function driverHarness(overrides = {}) {
    const calls = [];
    const accounts = {
        async login() { return { accountId }; },
        async listDevices() { return [{ uuid, model: 'msg100', name: 'Garage' }, { uuid: 'other', model: 'mss310' }]; },
        async discover(id, uuids, ownerId) { calls.push({ type: 'discover', id, uuids, ownerId }); return [{ id: endpointId, name: 'Garage', model: 'msg100', classHint: 'cover', traits: ['cover'] }]; },
        async releaseDiscovery(id, uuids, ownerId) { calls.push({ type: 'release', id, uuids, ownerId }); },
        ...overrides
    };
    const Driver = loadHomey('drivers/msg100/driver.js', { Driver: class {} });
    const driver = new Driver();
    driver.homey = { app: { accounts } };
    return { driver, accounts, calls };
}

function endpoint(open = false) {
    const value = new EventEmitter();
    value.online = true;
    value.report = open;
    value.isOnline = () => value.online;
    value.snapshot = () => [{ trait: 'cover', values: typeof value.report === 'boolean' ? { open: value.report } : {} }];
    value.commands = [];
    value.cover = {
        kind: 'garage',
        values: () => typeof value.report === 'boolean' ? { open: value.report } : {},
        async open() { value.commands.push('open'); return { open: value.report }; },
        async close() { value.commands.push('close'); return { open: value.report }; }
    };
    value.push = openValue => { value.report = openValue; value.emit('change', { trait: 'cover', values: { open: openValue } }); };
    return value;
}

function deviceHarness(initial = endpoint(), overrides = {}) {
    const calls = [];
    const timers = new Map();
    const accounts = new EventEmitter();
    accounts.endpoint = initial;
    accounts.acquireEndpoint = async (...args) => { calls.push({ type: 'acquire', args }); return accounts.endpoint; };
    accounts.releaseEndpoint = async (...args) => { calls.push({ type: 'release', args }); };
    Object.assign(accounts, overrides);
    class Device {
        getData() { return descriptor().data; }
        getStore() { return descriptor().store; }
        registerCapabilityListener(name, fn) { this.control = fn; }
        async setCapabilityValue(name, value) { this.capability = value; calls.push({ type: 'state', value }); }
        async setAvailable() { this.available = true; }
        async setUnavailable(reason) { this.available = false; this.reason = reason; }
        error() { calls.push({ type: 'error' }); }
    }
    const Msg100Device = loadHomey('drivers/msg100/device.js', { Device });
    const device = new Msg100Device();
    device.homey = {
        app: { accounts },
        setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    return { device, accounts, timers, calls };
}

test('MSG100 descriptors preserve account/endpoint identity and exclude unrelated hardware and credentials', () => {
    assert.equal(garage.isMsg100('MSG100'), true);
    assert.equal(garage.isMsg100('msg100hk'), true);
    assert.equal(garage.isMsg100('msg200'), false);
    assert.equal(garage.isMsg100('msg1000'), false);
    const paired = descriptor();
    assert.deepEqual(paired.data, { id: `${accountId}:${endpointId}` });
    assert.deepEqual(garage.identity(paired.data, paired.store), { accountId, uuid, endpointId, ownerId: paired.data.id });
    assert.equal(JSON.stringify(paired).includes('token'), false);
    assert.equal(garage.pairingDevice(accountId, { id: 'other:0', classHint: 'cover', traits: ['cover'] }, { uuid, model: 'msg100' }), null);
    assert.throws(() => garage.identity({ id: 'tampered' }, paired.store), /incomplete/);
});

test('open state is inverted only when reported as a boolean', () => {
    assert.equal(garage.closedValue({ open: true }), false);
    assert.equal(garage.closedValue({ open: false }), true);
    assert.equal(garage.closedValue({ moving: true }), undefined);
    assert.equal(garage.closedValue({ open: 0 }), undefined);
    assert.throws(() => garage.requireGarage({ cover: { kind: 'shutter' } }), /garage-door/);
});

test('pairing handles missing MFA, wrong MFA, and successful fresh-code retry in place', async () => {
    let attempt = 0;
    const saved = [];
    const { driver } = driverHarness({ async login(value, options) {
        saved.push({ ...value });
        assert.equal(options.isCurrent(), true);
        attempt++;
        if (attempt === 1) throw Object.assign(new Error('raw cloud detail'), { code: 'MFA_REQUIRED' });
        if (attempt === 2) throw Object.assign(new Error('raw cloud detail'), { code: 'MFA_WRONG' });
        return { accountId };
    } });
    const session = pairingSession();
    await driver.onPair(session);
    const input = { email: 'you@example.com', password: 'private-password' };
    assert.equal((await session.emit('login', input)).status, 'mfa_required');
    assert.equal((await session.emit('login', { ...input, mfaCode: '000000' })).status, 'mfa_wrong');
    assert.equal((await session.emit('login', { ...input, mfaCode: '012345' })).status, 'ok');
    assert.equal(saved[2].mfaCode, '012345');
    assert.equal(input.password, 'private-password');
});

test('pairing only enrolls MSG100 devices and releases its own discovery membership on disconnect', async () => {
    const { driver, calls } = driverHarness();
    const session = pairingSession();
    await driver.onPair(session);
    await session.emit('login', { email: 'you@example.com', password: 'password' });
    const choices = await session.emit('list_devices');
    assert.equal(choices.length, 1);
    assert.equal(choices[0].store.endpointId, endpointId);
    assert.deepEqual(Array.from(calls[0].uuids), [uuid]);
    assert.match(calls[0].ownerId, /^pair:/);
    await session.emit('disconnect');
    assert.equal(calls[1].ownerId, calls[0].ownerId);
    assert.equal((await session.emit('getContext')).repair, false);
});

test('cancelled pairing rejects a late login without discovering devices', async () => {
    const pending = deferred();
    let options;
    const { driver, calls } = driverHarness({ async login(value, opts) { options = opts; return pending.promise; } });
    const session = pairingSession();
    await driver.onPair(session);
    const login = session.emit('login', { email: 'you@example.com', password: 'password' });
    await flush();
    await session.emit('disconnect');
    assert.equal(options.isCurrent(), false);
    pending.resolve({ accountId });
    await assert.rejects(login, /connect to Meross|cancelled/);
    assert.equal(calls.length, 0);
});

test('cancelled pairing cannot restart discovery using the prior signed-in account', async () => {
    const { driver, calls } = driverHarness();
    const session = pairingSession();
    await driver.onPair(session);
    await session.emit('login', { email: 'you@example.com', password: 'password' });
    await session.emit('cancel_login');
    await assert.rejects(session.emit('list_devices'), /Sign in to Meross/);
    assert.equal(calls.length, 0);
});

test('repair enforces the existing account and allows successful account refresh with an offline opener', async () => {
    const opts = [];
    let wrong = true;
    const { driver } = driverHarness({ async login(value, options) {
        opts.push(options);
        if (wrong) throw Object.assign(new Error('details'), { code: 'WRONG_ACCOUNT' });
        return { accountId };
    } });
    const session = pairingSession();
    let reconnected = 0;
    await driver.onRepair(session, { getData: () => descriptor().data, getStore: () => descriptor().store, async reconnectAccount() { reconnected++; return false; } });
    await assert.rejects(session.emit('login', { email: 'other@example.com', password: 'password' }), /same Meross account/);
    assert.equal(reconnected, 0);
    wrong = false;
    const result = await session.emit('login', { email: 'you@example.com', password: 'password' });
    assert.equal(opts[1].expectedAccountId, accountId);
    assert.equal(result.status, 'ok');
    assert.equal(result.offline, true);
    assert.equal(reconnected, 1);
});

test('device seeds reported position without commands and waits for real state while moving', async () => {
    const ep = endpoint(false);
    const { device, calls, timers } = deviceHarness(ep);
    await device.onInit();
    assert.equal(device.available, true);
    assert.equal(device.capability, true);
    assert.deepEqual(ep.commands, []);
    let completed = false;
    const opening = device.control(false).then(() => { completed = true; });
    await flush();
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(device.capability, true, 'SETACK still reports closed while the motor starts');
    assert.equal(completed, false, 'Homey must not apply the requested target after SETACK alone');
    await assert.rejects(device.control(false), /already in progress/);
    ep.push(true);
    await opening;
    assert.equal(device.capability, false);
    assert.equal(completed, true);
    await device.control(false);
    assert.deepEqual(ep.commands, ['open'], 'an already open door must not receive another pulse');
    ep.cover.close = async () => { throw new Error('rejected command'); };
    await assert.rejects(device.control(true), /rejected command/);
    assert.equal(device.capability, false);
    assert.equal(timers.size, 0, 'a rejected command removes its confirmation timer');
    await device.onDeleted();
    assert.equal(calls.filter(value => value.type === 'release').length, 1);
});

test('confirmation handles a target report arriving before the command acknowledgement', async () => {
    const ep = endpoint(false);
    const ack = deferred();
    ep.cover.open = async () => {
        ep.commands.push('open');
        ep.push(true);
        return ack.promise;
    };
    const { device, timers } = deviceHarness(ep);
    await device.onInit();
    let complete = false;
    const opening = device.control(false).then(() => { complete = true; });
    await flush();
    assert.equal(device.capability, false);
    assert.equal(complete, false);
    ack.resolve({ open: true });
    await opening;
    assert.equal(complete, true);
    assert.equal(timers.size, 0);
    assert.equal(ep.listenerCount('change'), 1, 'temporary confirmation listener is removed');
    await device.onUninit();
});

test('unconfirmed movement times out once without retrying the physical command', async () => {
    const ep = endpoint(false);
    const { device, timers } = deviceHarness(ep);
    await device.onInit();
    const opening = device.control(false);
    const rejected = assert.rejects(opening, /within 45 seconds/);
    await flush();
    const [timerId, timer] = [...timers].find(([, value]) => value.ms === 45000);
    timers.delete(timerId);
    timer.fn();
    await rejected;
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(device.capability, true);
    assert.equal(ep.listenerCount('change'), 1);
    assert.equal(ep.listenerCount('availability'), 1);
    assert.equal(timers.size, 0);
    await device.onUninit();
});

test('a reported target that reverses before completion cannot resolve the requested capability', async () => {
    const ep = endpoint(false);
    const { device } = deviceHarness(ep);
    await device.onInit();
    const opening = device.control(false);
    const rejected = assert.rejects(opening, /position changed/);
    await flush();
    ep.push(true);
    ep.push(false);
    await rejected;
    await flush();
    assert.equal(device.capability, true);
    assert.deepEqual(ep.commands, ['open']);
    await device.onUninit();
});

test('offline cancellation rejects immediately and observes a late transport failure', async () => {
    const ep = endpoint(false);
    const ack = deferred();
    ep.cover.open = async () => { ep.commands.push('open'); ep.push(true); return ack.promise; };
    const { device, timers } = deviceHarness(ep);
    await device.onInit();
    const opening = device.control(false);
    const rejected = assert.rejects(opening, /disconnected before confirming/);
    await flush();
    ep.online = false;
    ep.emit('availability', false);
    await rejected;
    ack.reject(new Error('late transport failure'));
    await flush();
    assert.equal(device.capability, false, 'the last actual report is preserved after disconnect');
    assert.deepEqual(ep.commands, ['open']);
    assert.equal([...timers.values()].some(value => value.ms === 45000), false);
    assert.equal(ep.listenerCount('change'), 1);
    await device.onUninit();
    assert.equal(timers.size, 0);
});

test('account repair and deletion each cancel pending confirmation and remove temporary listeners', async () => {
    for (const action of ['repair', 'authentication', 'delete']) {
        const ep = endpoint(false);
        const { device, accounts, timers } = deviceHarness(ep);
        await device.onInit();
        const opening = device.control(false);
        const rejected = assert.rejects(opening, /connection changed/);
        await flush();
        if (action === 'repair') {
            accounts.endpoint = endpoint(false);
            accounts.emit('session', accountId);
        } else if (action === 'authentication') {
            accounts.emit('authentication', accountId);
        } else {
            await device.onDeleted();
        }
        await rejected;
        await flush();
        assert.deepEqual(ep.commands, ['open']);
        assert.equal(ep.listenerCount('change'), 0);
        assert.equal(ep.listenerCount('availability'), 0);
        assert.equal([...timers.values()].some(value => value.ms === 45000), false);
        if (action !== 'delete') await device.onUninit();
    }
});

test('unknown position and offline endpoints remain unavailable and never receive commands', async () => {
    const ep = endpoint(undefined);
    ep.report = undefined;
    const { device, timers } = deviceHarness(ep);
    await device.onInit();
    assert.equal(device.available, false);
    assert.equal(device.capability, undefined);
    assert.equal(timers.size, 1);
    await assert.rejects(device.control(false), /no current door position/);
    assert.deepEqual(ep.commands, []);
    ep.push(false);
    await flush();
    assert.equal(device.available, true);
    assert.equal(timers.size, 0);
    ep.online = false;
    ep.emit('availability', false);
    await flush();
    assert.equal(device.available, false);
    assert.equal(timers.size, 1);
    await device.onUninit();
    assert.equal(timers.size, 0);
});

test('repair rebinds to the new endpoint and ignores late updates from the previous session', async () => {
    const oldEndpoint = endpoint(false);
    const replacement = endpoint(true);
    const { device, accounts } = deviceHarness(oldEndpoint);
    await device.onInit();
    const lateHandler = oldEndpoint.listeners('change')[0];
    accounts.endpoint = replacement;
    accounts.emit('session', { accountId });
    await flush();
    assert.equal(device.capability, false);
    assert.equal(oldEndpoint.listenerCount('change'), 0);
    lateHandler({ trait: 'cover', values: { open: false } });
    await flush();
    assert.equal(device.capability, false);
    await device.onUninit();
    assert.equal(replacement.listenerCount('change'), 0);
});

test('deleting during enrollment releases its membership and prevents late state updates', async () => {
    const pending = deferred();
    const { device, calls, accounts, timers } = deviceHarness(endpoint(false), { async acquireEndpoint() { return pending.promise; } });
    const init = device.onInit();
    await flush();
    const removed = device.onDeleted();
    pending.resolve(endpoint(true));
    await Promise.all([init, removed]);
    assert.equal(device.capability, undefined);
    assert.equal(calls.filter(value => value.type === 'release').length, 1);
    assert.equal(accounts.listenerCount('session'), 0);
    assert.equal(timers.size, 0);
});

test('expired account blocks controls until repair and preserves the last reported position', async () => {
    const first = endpoint(false);
    const { device, accounts, timers } = deviceHarness(first);
    await device.onInit();
    accounts.emit('authentication', accountId);
    await flush();
    assert.equal(device.available, false);
    assert.match(device.reason, /repair screen/);
    assert.equal(device.capability, true);
    assert.equal(timers.size, 0);
    await assert.rejects(device.control(false), /no current door position/);
    assert.deepEqual(first.commands, []);
    const replacement = endpoint(true);
    accounts.endpoint = replacement;
    accounts.emit('session', accountId);
    await flush();
    assert.equal(device.available, true);
    assert.equal(device.capability, false);
    await device.onUninit();
    assert.equal(accounts.listenerCount('authentication'), 0);
});
