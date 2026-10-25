'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const {
    CAPABILITY, STATE_CAPABILITY, OPEN_CAPABILITY, CLOSE_CAPABILITY, DEVICE_CAPABILITIES,
    pairingDevice
} = require('../lib/garage');

const ACCOUNT = 'door-controls-account';
const UUID = 'door-controls-opener';
const ID = `${UUID}:0`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function endpoint(initial = false) {
    const ep = new EventEmitter();
    ep.reported = initial;
    ep.wire = initial;
    ep.online = true;
    ep.commands = [];
    ep.polls = 0;
    ep.isOnline = () => ep.online;
    ep.cover = {
        kind: 'garage',
        values: () => typeof ep.reported === 'boolean' ? { open: ep.reported } : {},
        async poll() {
            ep.polls++;
            const value = ep.read ? await ep.read() : typeof ep.wire === 'boolean' ? { open: ep.wire } : {};
            if (typeof value?.open === 'boolean') ep.reported = value.open;
            return value;
        },
        async open() {
            ep.commands.push('open');
            return ep.command ? ep.command(true) : { open: ep.reported };
        },
        async close() {
            ep.commands.push('close');
            return ep.command ? ep.command(false) : { open: ep.reported };
        }
    };
    ep.push = open => {
        ep.wire = open;
        ep.reported = open;
        ep.emit('change', { trait: 'cover', values: { open } });
    };
    return ep;
}

function harness(ep = endpoint(), options = {}) {
    const calls = [];
    const listeners = new Map();
    const values = new Map();
    const present = new Set(options.capabilities || [CAPABILITY]);
    const capabilityOptions = new Map([
        [CAPABILITY, { title: { en: 'Existing Flow status' }, preventTag: false, uiQuickAction: true }],
        [OPEN_CAPABILITY, { title: { en: 'Open' }, uiQuickAction: true }],
        [CLOSE_CAPABILITY, { title: { en: 'Close' }, uiQuickAction: true }]
    ]);
    const timers = new Map();
    const accounts = new EventEmitter();
    accounts.endpoint = ep;
    accounts.acquireEndpoint = async () => { calls.push({ type: 'acquire' }); return accounts.endpoint; };
    accounts.releaseEndpoint = async () => { calls.push({ type: 'release' }); };
    const descriptor = pairingDevice(ACCOUNT,
        { id: ID, name: 'Door', model: 'msg100', classHint: 'cover', traits: ['cover'] },
        { uuid: UUID, name: 'Door', model: 'msg100' });
    class HomeyDevice {
        getData() { return descriptor.data; }
        getStore() { return descriptor.store; }
        hasCapability(name) { return present.has(name); }
        async addCapability(name) {
            calls.push({ type: 'add', name });
            if (options.addCapability) await options.addCapability(name);
            present.add(name);
        }
        getCapabilityOptions(name) { return capabilityOptions.get(name) || {}; }
        async setCapabilityOptions(name, value) {
            capabilityOptions.set(name, structuredClone(value));
            calls.push({ type: 'options', name, value });
        }
        registerCapabilityListener(name, listener) { listeners.set(name, listener); }
        async setCapabilityValue(name, value) { values.set(name, value); calls.push({ type: 'state', name, value }); }
        async setAvailable() { this.available = true; }
        async setUnavailable(reason) { this.available = false; this.reason = reason; }
        async setWarning(message) { this.warning = message; calls.push({ type: 'warning', message }); }
        async unsetWarning() { this.warning = null; calls.push({ type: 'clear-warning' }); }
        error(...args) { calls.push({ type: 'error', args }); }
        log(...args) { calls.push({ type: 'log', args }); }
    }
    const filename = path.join(__dirname, '../drivers/msg100/device.js');
    const module = { exports: {} };
    const scopedRequire = name => name === 'homey' ? { Device: HomeyDevice }
        : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: scopedRequire, module, exports: module.exports
    }, { filename });
    const device = new module.exports();
    device.homey = {
        app: { accounts },
        setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    return {
        device, accounts, calls, listeners, values, timers, present, capabilityOptions,
        pressOpen: () => listeners.get(OPEN_CAPABILITY)(),
        pressClose: () => listeners.get(CLOSE_CAPABILITY)(),
        legacy: closed => listeners.get(CAPABILITY)(closed)
    };
}

function fireTimer(h, predicate) {
    const next = [...h.timers].find(([, timer]) => predicate(timer.ms));
    assert.ok(next, 'expected a pending timer');
    h.timers.delete(next[0]);
    next[1].fn();
}

test('existing device migration adds only missing controls and preserves legacy identity, options, tags and Flows', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    assert.deepEqual(h.calls.filter(call => call.type === 'add').map(call => call.name),
        DEVICE_CAPABILITIES.filter(capability => capability !== CAPABILITY));
    assert.equal(h.present.has(CAPABILITY), true);
    assert.equal(h.listeners.has(CAPABILITY), true);
    assert.equal(h.listeners.has(STATE_CAPABILITY), false, 'reported status must not have a write listener');
    assert.equal(h.listeners.has(OPEN_CAPABILITY), true);
    assert.equal(h.listeners.has(CLOSE_CAPABILITY), true);
    const legacy = h.capabilityOptions.get(CAPABILITY);
    assert.equal(legacy.uiComponent, null);
    assert.equal(legacy.uiQuickAction, false);
    assert.deepEqual(legacy.title, { en: 'Existing Flow status' });
    assert.equal(legacy.preventTag, false);
    assert.equal(h.capabilityOptions.get(OPEN_CAPABILITY).uiQuickAction, false);
    assert.equal(h.capabilityOptions.get(CLOSE_CAPABILITY).uiQuickAction, false);
    assert.equal(h.values.get(CAPABILITY), true);
    assert.equal(h.values.get(STATE_CAPABILITY), 'closed');
    assert.equal(h.calls.findIndex(call => call.type === 'options') < h.calls.findIndex(call => call.type === 'acquire'), true);
});

test('new devices with all capabilities already present do not add duplicates', async t => {
    const h = harness(endpoint(), { capabilities: DEVICE_CAPABILITIES });
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    assert.equal(h.calls.some(call => call.type === 'add'), false);
});

test('a previously migrated device does not rewrite unchanged capability options on restart', async t => {
    const h = harness(endpoint(), { capabilities: DEVICE_CAPABILITIES });
    t.after(() => h.device.onUninit());
    h.capabilityOptions.set(CAPABILITY, { title: { en: 'Existing Flow status' }, uiComponent: null, uiQuickAction: false });
    h.capabilityOptions.set(OPEN_CAPABILITY, { title: { en: 'Open' }, uiQuickAction: false });
    h.capabilityOptions.set(CLOSE_CAPABILITY, { title: { en: 'Close' }, uiQuickAction: false });
    await h.device.onInit();
    assert.equal(h.calls.some(call => call.type === 'options'), false);
    assert.equal(h.calls.some(call => call.type === 'add'), false);
});

test('deletion during an awaited capability migration stops further initialization without undefined listener errors', async () => {
    const gate = deferred();
    const h = harness(endpoint(), { addCapability: () => gate.promise });
    const initializing = h.device.onInit();
    await flush();
    await h.device.onDeleted();
    gate.resolve();
    await initializing;
    assert.equal(h.listeners.size, 0);
    assert.equal(h.calls.some(call => call.type === 'acquire'), false);
    assert.equal(h.accounts.listenerCount('session'), 0);
    assert.equal(h.accounts.listenerCount('authentication'), 0);
    assert.equal(h.timers.size, 0);
});

test('Open button resolves at acknowledgement while Door status stays reported closed until the contact changes', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    await h.pressOpen();
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(h.values.get(STATE_CAPABILITY), 'closed');
    assert.equal(h.values.get(CAPABILITY), true);
    assert.equal(h.device._commandPending, true);
    await assert.rejects(h.pressClose(), /already in progress/);
    ep.push(true);
    await flush();
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    assert.equal(h.values.get(CAPABILITY), false);
    assert.equal(h.device._commandPending, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.calls.filter(call => call.type === 'state').every(call => [CAPABILITY, STATE_CAPABILITY].includes(call.name)), true,
        'button values are never written as reported state');
});

test('a target contact report before SETACK updates status but the button still waits for acknowledgement', async t => {
    const ep = endpoint();
    const ack = deferred();
    ep.command = async () => { ep.push(true); return ack.promise; };
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    let finished = false;
    const opening = h.pressOpen().then(() => { finished = true; });
    await flush();
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    assert.equal(finished, false);
    ack.resolve({ open: true });
    await opening;
    await flush();
    assert.equal(finished, true);
    assert.equal(h.device._commandPending, false);
});

test('legacy capability and existing Flows still wait for actual movement confirmation', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    let completed = false;
    const opening = h.legacy(false).then(() => { completed = true; });
    await flush();
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(completed, false);
    ep.push(true);
    await opening;
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    assert.equal(completed, true);
});

test('fresh preflight status can skip an already satisfied button request without another physical pulse', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.wire = true;
    await h.pressOpen();
    assert.deepEqual(ep.commands, []);
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    assert.equal(h.device._commandPending, false);
});

test('Close button refreshes stale closed state before deciding to command and never publishes its target optimistically', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.wire = true;
    await h.pressClose();
    assert.deepEqual(ep.commands, ['close']);
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    ep.push(false);
    await flush();
    assert.equal(h.values.get(STATE_CAPABILITY), 'closed');
    assert.equal(h.device._commandPending, false);
});

test('unknown and offline positions refuse both buttons without sending commands', async t => {
    for (const mode of ['unknown', 'offline']) {
        const ep = endpoint();
        if (mode === 'unknown') ep.wire = ep.reported = undefined;
        else ep.online = false;
        const h = harness(ep);
        t.after(() => h.device.onUninit());
        await h.device.onInit();
        await assert.rejects(h.pressOpen(), /no current door position/);
        await assert.rejects(h.pressClose(), /no current door position/);
        assert.deepEqual(ep.commands, []);
        assert.equal(h.device.available, false);
    }
});

test('read-only polling completes an acknowledged button movement without retrying its command', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    await h.pressOpen();
    ep.wire = true;
    fireTimer(h, ms => ms > 0 && ms < 45000);
    await flush();
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    assert.equal(h.device._commandPending, false);
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(h.timers.size, 0);
});

test('unconfirmed acknowledged movement logs and warns once, retains actual state, and clears only when its target is reported', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    await h.pressOpen();
    fireTimer(h, ms => ms === 45000);
    await flush();
    assert.match(h.device.warning, /accepted.*did not confirm/);
    assert.equal(h.device._commandPending, false);
    assert.equal(h.values.get(STATE_CAPABILITY), 'closed');
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(h.timers.size, 0);
    ep.push(false);
    await flush();
    assert.match(h.device.warning, /accepted.*did not confirm/, 'another closed report cannot clear the failed Open warning');
    ep.push(true);
    await flush();
    assert.equal(h.device.warning, null);
    assert.equal(h.values.get(STATE_CAPABILITY), 'open');
    assert.equal(h.calls.filter(call => call.type === 'warning').length, 1);
});

test('SETACK failure rejects the button safely and releases confirmation resources without optimistic status', async t => {
    const ep = endpoint();
    ep.command = async () => { throw Object.assign(new Error('fixture-private-token'), { code: 'COMMAND_TIMEOUT' }); };
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    await assert.rejects(h.pressOpen(), error => {
        assert.match(error.message, /command failed/);
        assert.equal(error.message.includes('fixture-private-token'), false);
        return true;
    });
    await flush();
    assert.equal(h.values.get(STATE_CAPABILITY), 'closed');
    assert.equal(h.device._commandPending, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.device.warning, null);
    assert.equal(h.calls.filter(call => call.type === 'error').flatMap(call => call.args).join('\n').includes('fixture-private-token'), false);
});

test('disconnect before SETACK rejects promptly but retains the command lock until its late wire result settles', async t => {
    const ep = endpoint();
    const ack = deferred();
    ep.command = () => ack.promise;
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    const opening = h.pressOpen();
    const rejected = assert.rejects(opening, /disconnected|connection changed/);
    await flush();
    ep.online = false;
    ep.emit('availability', false);
    await rejected;
    assert.equal(h.device._commandPending, true);
    ack.reject(new Error('late fixture wire failure'));
    await flush();
    assert.equal(h.device._commandPending, false);
    assert.deepEqual(ep.commands, ['open']);
    assert.equal([...h.timers.values()].some(timer => timer.ms <= 45000), false);
});

for (const action of ['authentication', 'repair', 'delete']) {
    test(`${action} cancels acknowledged background confirmation and leaves no obsolete update listeners`, async t => {
        const ep = endpoint();
        const h = harness(ep);
        t.after(() => h.device.onUninit());
        await h.device.onInit();
        await h.pressOpen();
        if (action === 'authentication') h.accounts.emit('authentication', ACCOUNT);
        else if (action === 'repair') {
            h.accounts.endpoint = endpoint();
            h.accounts.emit('session', ACCOUNT);
        } else await h.device.onDeleted();
        await flush();
        ep.push(true);
        await flush();
        assert.deepEqual(ep.commands, ['open']);
        assert.equal(h.values.get(STATE_CAPABILITY), 'closed');
        assert.equal(ep.listenerCount('change'), 0);
        assert.equal(ep.listenerCount('availability'), 0);
        assert.equal([...h.timers.values()].some(timer => timer.ms <= 45000), false);
        assert.equal(h.device.warning, null);
    });
}
