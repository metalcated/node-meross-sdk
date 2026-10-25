'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { CAPABILITY, pairingDevice } = require('../lib/garage');

const UUID = 'position-refresh-opener';
const ACCOUNT = 'position-refresh-account';
const ENDPOINT = `${UUID}:0`;
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/**
 * A direct Garage.State read updates the SDK cache but emits no unsolicited
 * PUSH here. The host must consume poll()'s returned values as fresh evidence.
 */
function endpoint({ cache = false, wire = cache } = {}) {
    const value = new EventEmitter();
    value.cache = cache;
    value.wire = wire;
    value.online = true;
    value.commands = [];
    value.pollCalls = 0;
    value.isOnline = () => value.online;
    value.snapshot = () => [{ trait: 'cover', values: value.cover.values() }];
    value.cover = {
        kind: 'garage',
        values: () => typeof value.cache === 'boolean' ? { open: value.cache } : {},
        async poll() {
            value.pollCalls++;
            const state = value.pollImpl ? await value.pollImpl() : { open: value.wire };
            if (typeof state?.open === 'boolean') value.cache = state.open;
            return state;
        },
        async open() {
            value.commands.push('open');
            if (value.commandImpl) return value.commandImpl(true);
            return { open: value.cache };
        },
        async close() {
            value.commands.push('close');
            if (value.commandImpl) return value.commandImpl(false);
            return { open: value.cache };
        }
    };
    value.push = open => {
        value.wire = open;
        value.cache = open;
        value.emit('change', { trait: 'cover', values: { open } });
    };
    return value;
}

function harness(initial = endpoint()) {
    const calls = [];
    const timers = new Map();
    const accounts = new EventEmitter();
    accounts.endpoint = initial;
    accounts.acquireEndpoint = async () => accounts.endpoint;
    accounts.releaseEndpoint = async () => { calls.push({ type: 'release' }); };
    const descriptor = pairingDevice(ACCOUNT,
        { id: ENDPOINT, name: 'Garage', model: 'msg100', classHint: 'cover', traits: ['cover'] },
        { uuid: UUID, name: 'Garage', model: 'msg100' });
    class HomeyDevice {
        getData() { return descriptor.data; }
        getStore() { return descriptor.store; }
        hasCapability() { return true; }
        getCapabilityOptions(name) { return require('../app.json').drivers[0].capabilitiesOptions[name] || {}; }
        async setCapabilityOptions() {}
        async unsetWarning() {}
        registerCapabilityListener(name, listener) {
            if (name === CAPABILITY) this.control = listener;
        }
        async setCapabilityValue(name, state) {
            if (name === CAPABILITY) {
                this.capability = state;
                calls.push({ type: 'position', state });
            }
        }
        async setAvailable() { this.available = true; }
        async setUnavailable(reason) { this.available = false; this.reason = reason; }
        error(...args) { calls.push({ type: 'error', args }); }
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
    return { device, accounts, timers, calls };
}

function fireReadTimer(h) {
    const next = [...h.timers].find(([, timer]) => timer.ms > 0 && timer.ms < 45000);
    if (!next) return false;
    h.timers.delete(next[0]);
    next[1].fn();
    return true;
}

async function settleFromReads(promise, h) {
    let done = false;
    let failure;
    promise.then(() => { done = true; }, error => { done = true; failure = error; });
    for (let i = 0; i < 12 && !done; i++) {
        await flush();
        if (!done) fireReadTimer(h);
    }
    assert.equal(done, true, 'a fresh target read should complete confirmation without waiting for a PUSH');
    if (failure) throw failure;
    await promise;
}

test('reconnect refreshes a stale snapshot from the opener before exposing its position', async t => {
    const ep = endpoint({ cache: false, wire: true });
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    assert.ok(ep.pollCalls >= 1, 'reconnect must perform a direct state read');
    assert.equal(h.device.available, true);
    assert.equal(h.device.capability, false, 'wire reports open even though the cached snapshot reported closed');
    assert.deepEqual(ep.commands, []);
});

test('reconnect stays unavailable while its first fresh read is pending instead of publishing a stale ready snapshot', async t => {
    const ep = endpoint({ cache: false, wire: true });
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    const read = deferred();
    ep.pollImpl = () => read.promise;
    const initializing = h.device.onInit();
    await flush();
    assert.equal(ep.pollCalls, 1);
    assert.equal(h.device.available, false);
    assert.equal(h.device.capability, undefined);
    await assert.rejects(h.device.control(false), /no current door position/i);
    assert.deepEqual(ep.commands, []);
    read.resolve({ open: true });
    await initializing;
    assert.equal(h.device.available, true);
    assert.equal(h.device.capability, false);
});

test('precommand refresh makes a stale already-closed decision send exactly one close after learning the door is open', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.wire = true;
    ep.commandImpl = async target => {
        ep.wire = target;
        return { open: ep.cache };
    };
    await settleFromReads(h.device.control(true), h);
    assert.deepEqual(ep.commands, ['close']);
    assert.equal(h.device.capability, true);
});

test('a fresh already-open read skips the physical pulse even when the SDK cache still reports closed', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.wire = true;
    await settleFromReads(h.device.control(false), h);
    assert.deepEqual(ep.commands, [], 'an already satisfied target must never pulse the opener');
    assert.equal(h.device.capability, false);
});

test('an accepted command with no PUSH completes from repeated read-only state reports without another SET', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    let movementReads = 0;
    ep.pollImpl = async () => {
        if (ep.commands.length && ++movementReads >= 2) ep.wire = true;
        return { open: ep.wire };
    };
    const moving = h.device.control(false);
    await flush();
    assert.equal(h.device.capability, true, 'SETACK with the old contact state cannot imply physical completion');
    await settleFromReads(moving, h);
    assert.ok(movementReads >= 2);
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(h.device.capability, false);
    assert.equal([...h.timers.values()].some(timer => timer.ms > 0 && timer.ms <= 45000), false);
});

test('the command lock covers a delayed preflight read so a second tap cannot produce another SET', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    const read = deferred();
    ep.pollImpl = () => read.promise;
    const moving = h.device.control(false);
    await flush();
    assert.deepEqual(ep.commands, []);
    await assert.rejects(h.device.control(false), /already in progress/i);
    ep.pollImpl = async () => ({ open: ep.wire });
    ep.commandImpl = async target => { ep.wire = target; return { open: ep.cache }; };
    read.resolve({ open: false });
    await settleFromReads(moving, h);
    assert.deepEqual(ep.commands, ['open']);
});

test('a late old-session read cannot overwrite the position from a repaired endpoint', async t => {
    const old = endpoint();
    const replacement = endpoint({ cache: true, wire: true });
    const h = harness(old);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    assert.equal(typeof h.device._refreshPosition, 'function');
    const read = deferred();
    old.pollImpl = () => read.promise;
    const staleRead = h.device._refreshPosition(h.device._generation, old);
    const observed = Promise.allSettled([staleRead]);
    await flush();
    h.accounts.endpoint = replacement;
    h.accounts.emit('session', ACCOUNT);
    await flush();
    assert.equal(h.device.capability, false);
    read.resolve({ open: false });
    await observed;
    await flush();
    assert.equal(h.device.capability, false);
    assert.equal(old.listenerCount('change'), 0);
    assert.deepEqual(old.commands, []);
});

for (const action of ['authentication', 'delete']) {
    test(`${action} cancels confirmation reads and ignores a late target report`, async t => {
        const ep = endpoint();
        const h = harness(ep);
        t.after(() => h.device.onUninit());
        await h.device.onInit();
        const read = deferred();
        ep.pollImpl = () => ep.commands.length ? read.promise : Promise.resolve({ open: false });
        const moving = h.device.control(false);
        const rejected = assert.rejects(moving, /connection changed|disconnected|cancelled/i);
        await flush();
        assert.deepEqual(ep.commands, ['open']);
        if (!ep.pollCalls || ep.pollCalls < 3) {
            fireReadTimer(h);
            await flush();
        }
        if (action === 'authentication') h.accounts.emit('authentication', ACCOUNT);
        else await h.device.onDeleted();
        await rejected;
        read.resolve({ open: true });
        await flush();
        assert.equal(h.device.capability, true, 'late read cannot publish a position after its session was detached');
        assert.deepEqual(ep.commands, ['open']);
        assert.equal(ep.listenerCount('change'), 0);
        assert.equal([...h.timers.values()].some(timer => timer.ms > 0 && timer.ms <= 45000), false);
    });
}

test('events for a different account cannot interrupt this opener or its read-only confirmation', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.commandImpl = async target => { ep.wire = target; return { open: ep.cache }; };
    h.accounts.emit('authentication', 'another-account');
    h.accounts.emit('session', 'another-account');
    await settleFromReads(h.device.control(false), h);
    assert.deepEqual(ep.commands, ['open']);
    assert.equal(h.device.capability, false);
    assert.equal(h.device.available, true);
});

test('a failed preflight read never sends a command or replaces the last actual contact state', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.pollImpl = async () => {
        throw Object.assign(new Error('fixture-private-token timed out after 10000ms'), { code: 'COMMAND_TIMEOUT' });
    };
    await assert.rejects(h.device.control(false), error => {
        assert.equal(error.message.includes('fixture-private-token'), false);
        assert.match(error.message, /position|read|connect|try again/i);
        assert.equal(typeof error.stack, 'string');
        return true;
    });
    assert.deepEqual(ep.commands, []);
    assert.equal(h.device.capability, true);
    assert.equal([...h.timers.values()].some(timer => timer.ms > 0 && timer.ms <= 45000), false);
    const logged = h.calls.filter(call => call.type === 'error').flatMap(call => call.args).join('\n');
    assert.match(logged, /position read.*COMMAND_TIMEOUT/);
    assert.match(logged, /\bat /, 'diagnostics retain stack frames that identify the failing transport phase');
    assert.equal(logged.includes('fixture-private-token'), false);
});

test('a fresh read without a contact state cannot reuse the old cache as permission to pulse the opener', async t => {
    const ep = endpoint();
    const h = harness(ep);
    t.after(() => h.device.onUninit());
    await h.device.onInit();
    ep.pollImpl = async () => ({});
    const moving = h.device.control(false);
    const rejected = assert.rejects(moving, /position|read|connect|try again/i);
    await flush();
    assert.deepEqual(ep.commands, []);
    await rejected;
    assert.equal(h.device.capability, true);
    assert.equal([...h.timers.values()].some(timer => timer.ms > 0 && timer.ms <= 45000), false);
});
