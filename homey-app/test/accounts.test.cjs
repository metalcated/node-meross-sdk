'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const { Accounts, SETTINGS_KEY, safeCode } = require('../lib/accounts');

const ACCOUNT_ID = 'user-42';
const UUID = 'garage-opener';
const ENDPOINT = `${UUID}:0`;
const EMAIL = 'owner@example.test';
const PASSWORD = 'fixture-password';

function error(code, message = code) {
    return Object.assign(new Error(message), { code });
}

function token(overrides = {}) {
    return {
        token: 'fixture-token',
        key: 'fixture-key',
        userId: ACCOUNT_ID,
        userEmail: EMAIL,
        domain: 'iotx-us.meross.com',
        mqttDomain: 'us-iotx.meross.com',
        ...overrides
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(next => { resolve = next; });
    return { promise, resolve };
}

function savedRecord(savedToken = token()) {
    return { version: 1, accounts: [{ id: ACCOUNT_ID, email: EMAIL, token: savedToken }] };
}

function fixture({ saved, plans = [], restorePlans = [] } = {}) {
    const calls = { login: [], restore: [], loginOptions: [], restoreOptions: [], settings: [] };
    const sessions = [];
    const warnings = [];
    const data = new Map(saved ? [[SETTINGS_KEY, structuredClone(saved)]] : []);
    const settings = {
        failNext: false,
        onSet: undefined,
        get(key) { return structuredClone(data.get(key)); },
        async set(key, value) {
            if (this.failNext) {
                this.failNext = false;
                throw error('STORE_FAILED');
            }
            data.set(key, structuredClone(value));
            calls.settings.push(structuredClone(value));
            this.onSet?.();
        }
    };

    class FakeSession extends EventEmitter {
        constructor(savedToken, plan = {}) {
            super();
            this.token = structuredClone(savedToken);
            this.plan = plan;
            this.calls = { connect: 0, disconnect: 0, logout: 0, list: 0, enroll: [], unenroll: [] };
            this.enrolled = new Set();
            this.endpoints = new Map();
            this.inventory = { endpoints: () => [...this.enrolled].map(uuid => ({
                id: `${uuid}:0`, name: 'Garage opener', model: 'msg100', classHint: 'cover', traits: ['cover']
            })) };
            sessions.push(this);
        }
        getToken() { return structuredClone(this.token); }
        async listDevices() {
            this.calls.list++;
            if (this.plan.listError) throw this.plan.listError;
            return [{ uuid: UUID, name: 'Garage opener', model: 'msg100', onlineStatus: 1, channels: [] }];
        }
        async connect() {
            this.calls.connect++;
            await this.plan.connectGate;
            if (this.plan.connectError) throw this.plan.connectError;
        }
        async enroll(uuids) {
            this.calls.enroll.push([...uuids]);
            await this.plan.enrollGate;
            if (this.plan.enrollError) throw this.plan.enrollError;
            const report = this.plan.report || { enrolled: [...uuids], skipped: [], failed: [] };
            for (const uuid of report.enrolled) this.enrolled.add(uuid);
            return report;
        }
        endpoint(id) {
            if (!this.enrolled.has(id.split(/[:#]/, 1)[0])) throw error('ENDPOINT_NOT_FOUND');
            if (!this.endpoints.has(id)) this.endpoints.set(id, Object.assign(new EventEmitter(), { id }));
            return this.endpoints.get(id);
        }
        async unenroll(uuid) {
            this.calls.unenroll.push(uuid);
            this.enrolled.delete(uuid);
        }
        async disconnect() {
            this.calls.disconnect++;
            this.enrolled.clear();
            if (this.plan.disconnectError) throw this.plan.disconnectError;
        }
        async logout() {
            this.calls.logout++;
            await this.disconnect();
            if (this.plan.logoutError) throw this.plan.logoutError;
        }
    }

    const Session = {
        async login(credentials, options) {
            calls.login.push({ ...credentials });
            calls.loginOptions.push(structuredClone(options));
            const plan = plans.shift() || {};
            await plan.loginGate;
            if (plan.loginError) throw plan.loginError;
            return new FakeSession(plan.token || token(), plan);
        },
        restore(savedToken, options) {
            calls.restore.push(structuredClone(savedToken));
            calls.restoreOptions.push(structuredClone(options));
            const plan = restorePlans.shift() || {};
            if (plan.restoreError) throw plan.restoreError;
            return new FakeSession(savedToken, plan);
        }
    };
    const accounts = new Accounts({ Session, settings, warn: message => warnings.push(message) });
    return { accounts, settings, calls, sessions, warnings, data };
}

function signIn(accounts, mfaCode, options) {
    return accounts.login({ email: EMAIL, password: PASSWORD, ...(mfaCode ? { mfaCode } : {}) }, options);
}

test('new and restored Homey sessions opt into the MSG100 state-only polling profile', async t => {
    const f = fixture({ saved: savedRecord() });
    t.after(() => f.accounts.close());
    await f.accounts.listDevices(ACCOUNT_ID);
    assert.deepEqual(f.calls.restoreOptions, [{ garageStatePolling: true }]);
    await signIn(f.accounts);
    assert.deepEqual(f.calls.loginOptions, [{ garageStatePolling: true }]);
});

test('missing MFA and wrong code can retry with a fresh code; only session token is persisted', async t => {
    const f = fixture({ plans: [
        { loginError: error('MFA_REQUIRED') },
        { loginError: error('MFA_WRONG') },
        {}
    ] });
    t.after(() => f.accounts.close());

    await assert.rejects(signIn(f.accounts), { code: 'MFA_REQUIRED' });
    await assert.rejects(signIn(f.accounts, '123456'), { code: 'MFA_WRONG' });
    assert.equal(f.data.has(SETTINGS_KEY), false);
    assert.deepEqual(await signIn(f.accounts, '654321'), { accountId: ACCOUNT_ID });

    assert.deepEqual(f.calls.login.map(call => call.mfaCode), [undefined, '123456', '654321']);
    const persisted = JSON.stringify(f.data.get(SETTINGS_KEY));
    assert.equal(persisted.includes(PASSWORD), false);
    assert.equal(persisted.includes('123456'), false);
    assert.equal(persisted.includes('654321'), false);
    assert.equal(persisted.includes('password'), false);
    assert.equal(persisted.includes('mfaCode'), false);
    assert.equal(f.accounts.getAccountEmail(ACCOUNT_ID), EMAIL);
    assert.equal(f.sessions[0].calls.list, 1);
    assert.equal(f.sessions[0].calls.connect, 1);
});

test('invalid email, missing password and malformed OTP do not reach the SDK', async t => {
    const f = fixture();
    t.after(() => f.accounts.close());
    await assert.rejects(f.accounts.login({ email: 'invalid', password: PASSWORD }), { code: 'AUTHENTICATION' });
    await assert.rejects(f.accounts.login({ email: EMAIL, password: '' }), { code: 'AUTHENTICATION' });
    await assert.rejects(signIn(f.accounts, '12345x'), { code: 'MFA_WRONG' });
    assert.equal(f.calls.login.length, 0);
    assert.equal(f.calls.settings.length, 0);
});

test('startup restores persisted credentials without a password sign-in and shares endpoint enrollment', async t => {
    const f = fixture({ saved: savedRecord() });
    t.after(() => f.accounts.close());
    const [first, second] = await Promise.all([
        f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a'),
        f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-b')
    ]);
    assert.equal(first, second);
    assert.equal(f.calls.login.length, 0);
    assert.equal(f.calls.restore.length, 1);
    assert.deepEqual(f.calls.restore[0], token());
    assert.equal(f.calls.settings.length, 0);
    assert.equal(f.sessions.length, 1);
});

test('wrong-account repair rejects candidate and preserves the existing session and stored token', async t => {
    const f = fixture({ saved: savedRecord(), plans: [{ token: token({ userId: 'other-user', token: 'other-token' }) }] });
    t.after(() => f.accounts.close());
    const oldEndpoint = await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    const before = f.settings.get(SETTINGS_KEY);
    await assert.rejects(signIn(f.accounts, '123456', { expectedAccountId: ACCOUNT_ID }), { code: 'WRONG_ACCOUNT' });
    assert.deepEqual(f.settings.get(SETTINGS_KEY), before);
    assert.equal(f.sessions[0].calls.logout, 0);
    assert.equal(f.sessions[0].calls.disconnect, 0);
    assert.equal(f.sessions[1].calls.logout, 1);
    assert.equal(await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a'), oldEndpoint);
});

for (const failureType of ['broker', 'store']) {
    test(`${failureType} failure during repair retains prior credentials, endpoint and active session`, async t => {
        const f = fixture({ saved: savedRecord(), plans: [{
            token: token({ token: 'candidate-token' }),
            ...(failureType === 'broker' ? { connectError: error('MQTT_ERROR') } : {})
        }] });
        t.after(() => f.accounts.close());
        const oldEndpoint = await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
        const before = f.settings.get(SETTINGS_KEY);
        if (failureType === 'store') f.settings.failNext = true;
        await assert.rejects(signIn(f.accounts, '123456', { expectedAccountId: ACCOUNT_ID }), {
            code: failureType === 'broker' ? 'MQTT_ERROR' : 'STORE_FAILED'
        });
        assert.deepEqual(f.settings.get(SETTINGS_KEY), before);
        assert.equal(f.sessions[0].calls.logout, 0);
        assert.equal(f.sessions[0].calls.disconnect, 0);
        assert.equal(f.sessions[1].calls.logout, 1);
        assert.equal(await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a'), oldEndpoint);
    });
}

test('cancellation while login is in flight prevents a late result from committing and cleans it up', async t => {
    const gate = deferred();
    let current = true;
    const f = fixture({ plans: [{ loginGate: gate.promise }] });
    t.after(() => f.accounts.close());
    const signingIn = signIn(f.accounts, '123456', { isCurrent: () => current });
    await Promise.resolve();
    current = false;
    gate.resolve();
    await assert.rejects(signingIn, { code: 'LOGIN_CANCELLED' });
    assert.equal(f.calls.settings.length, 0);
    assert.equal(f.accounts.records.size, 0);
    assert.equal(f.accounts.entries.size, 0);
    assert.equal(f.sessions[0].calls.logout, 1);
});

test('cancellation after persistence restores the prior settings before rejecting repair', async t => {
    let current = true;
    const f = fixture({ saved: savedRecord(), plans: [{ token: token({ token: 'candidate-token' }) }] });
    t.after(() => f.accounts.close());
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    const before = f.settings.get(SETTINGS_KEY);
    f.settings.onSet = () => { current = false; };
    await assert.rejects(signIn(f.accounts, '123456', {
        expectedAccountId: ACCOUNT_ID, isCurrent: () => current
    }), { code: 'LOGIN_CANCELLED' });
    assert.deepEqual(f.settings.get(SETTINGS_KEY), before);
    assert.equal(f.sessions[0].calls.logout, 0);
    assert.equal(f.sessions[1].calls.logout, 1);
});

test('successful repair replaces the session only after persistence, preserves refs and retires the old token', async t => {
    const f = fixture({ saved: savedRecord(), plans: [{ token: token({ token: 'candidate-token' }) }] });
    t.after(() => f.accounts.close());
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    const oldSession = f.sessions[0];
    const notifications = [];
    f.accounts.on('session', accountId => notifications.push({
        accountId, stored: f.settings.get(SETTINGS_KEY).accounts[0].token.token,
        currentSession: f.accounts.entries.get(accountId).session
    }));
    await signIn(f.accounts, '123456', { expectedAccountId: ACCOUNT_ID });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].stored, 'candidate-token');
    assert.equal(notifications[0].currentSession, f.sessions[1]);
    assert.equal(oldSession.calls.logout, 1);
    assert.deepEqual(f.sessions[1].calls.enroll, [[UUID]]);
    assert.equal(f.accounts.entries.get(ACCOUNT_ID).refs.get('device-a'), UUID);
});

test('repair with an identical token disconnects the retired session without revoking the adopted token', async t => {
    const f = fixture({ saved: savedRecord(), plans: [{ token: token() }] });
    t.after(() => f.accounts.close());
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    await signIn(f.accounts, '123456', { expectedAccountId: ACCOUNT_ID });
    assert.equal(f.sessions[0].calls.logout, 0);
    assert.equal(f.sessions[0].calls.disconnect, 1);
    assert.equal(f.accounts.entries.get(ACCOUNT_ID).session, f.sessions[1]);
});

test('a failed repair candidate sharing the current token cannot revoke the working account during cleanup', async t => {
    const f = fixture({ saved: savedRecord(), plans: [{ token: token(), connectError: error('MQTT_ERROR') }] });
    t.after(() => f.accounts.close());
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    await assert.rejects(signIn(f.accounts, '123456', { expectedAccountId: ACCOUNT_ID }), { code: 'MQTT_ERROR' });
    assert.equal(f.sessions[1].calls.logout, 0);
    assert.equal(f.sessions[1].calls.disconnect, 1);
    assert.equal(f.sessions[0].calls.disconnect, 0);
    assert.deepEqual(f.settings.get(SETTINGS_KEY), savedRecord());
});

test('late authentication warnings from a retired session cannot invalidate the repaired account', async t => {
    const f = fixture({ saved: savedRecord(), plans: [{ token: token({ token: 'candidate-token' }) }] });
    t.after(() => f.accounts.close());
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    const expired = [];
    f.accounts.on('authentication', accountId => expired.push(accountId));
    await signIn(f.accounts, '123456', { expectedAccountId: ACCOUNT_ID });
    f.sessions[0].emit('warning', error('TOKEN_EXPIRED', 'sensitive obsolete response'));
    assert.deepEqual(expired, []);
    f.sessions[1].emit('warning', error('TOKEN_EXPIRED', 'sensitive current response'));
    assert.deepEqual(expired, [ACCOUNT_ID]);
    assert.equal(f.warnings.some(message => message.includes('sensitive')), false);
});

test('deleting one Homey endpoint retains a shared physical opener until its last reference is released', async t => {
    const f = fixture({ saved: savedRecord() });
    t.after(() => f.accounts.close());
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-b');
    await f.accounts.releaseEndpoint(ACCOUNT_ID, UUID, 'device-a');
    assert.deepEqual(f.sessions[0].calls.unenroll, []);
    await f.accounts.releaseEndpoint(ACCOUNT_ID, UUID, 'device-b');
    assert.deepEqual(f.sessions[0].calls.unenroll, [UUID]);
});

test('pairing discovery ownership prevents one pairing window from releasing another window\'s opener', async t => {
    const f = fixture({ saved: savedRecord() });
    t.after(() => f.accounts.close());
    await f.accounts.discover(ACCOUNT_ID, [UUID], 'pair-a');
    await f.accounts.discover(ACCOUNT_ID, [UUID], 'pair-b');
    await f.accounts.releaseDiscovery(ACCOUNT_ID, [UUID], 'pair-a');
    assert.deepEqual(f.sessions[0].calls.unenroll, []);
    await f.accounts.releaseDiscovery(ACCOUNT_ID, [UUID], 'pair-b');
    assert.deepEqual(f.sessions[0].calls.unenroll, [UUID]);
});

test('offline and failed discovery are reported rather than treated as completed enrollment', async t => {
    for (const [report, expected] of [
        [{ enrolled: [], skipped: [{ uuid: UUID, reason: 'offline' }], failed: [] }, 'DEVICE_OFFLINE'],
        [{ enrolled: [], skipped: [], failed: [{ uuid: UUID, error: error('COMMAND_TIMEOUT') }] }, 'DISCOVERY_FAILED']
    ]) {
        const f = fixture({ saved: savedRecord(), restorePlans: [{ report }] });
        t.after(() => f.accounts.close());
        await assert.rejects(f.accounts.discover(ACCOUNT_ID, [UUID], expected), { code: expected });
    }
});

test('expired restored credentials emit repair state without launching a password login', async t => {
    const f = fixture({ saved: savedRecord(), restorePlans: [{ listError: error('TOKEN_EXPIRED') }] });
    t.after(() => f.accounts.close());
    const expired = [];
    f.accounts.on('authentication', accountId => expired.push(accountId));
    await assert.rejects(f.accounts.listDevices(ACCOUNT_ID), { code: 'TOKEN_EXPIRED' });
    assert.deepEqual(expired, [ACCOUNT_ID]);
    assert.equal(f.calls.login.length, 0);
    assert.deepEqual(f.settings.get(SETTINGS_KEY), savedRecord());
});

test('close cancels an in-flight login, disconnects restored sessions without logout, and refuses later work', async () => {
    const gate = deferred();
    const f = fixture({ saved: savedRecord(), plans: [{ loginGate: gate.promise, token: token({ token: 'candidate-token' }) }] });
    await f.accounts.acquireEndpoint(ACCOUNT_ID, UUID, ENDPOINT, 'device-a');
    const signingIn = signIn(f.accounts, '123456');
    await Promise.resolve();
    const closed = f.accounts.close();
    gate.resolve();
    await assert.rejects(signingIn, { code: 'LOGIN_CANCELLED' });
    await closed;
    assert.equal(f.sessions[0].calls.logout, 0);
    assert.equal(f.sessions[0].calls.disconnect, 1);
    assert.equal(f.sessions[1].calls.logout, 1);
    assert.equal(f.accounts.entries.size, 0);
    assert.deepEqual(f.settings.get(SETTINGS_KEY), savedRecord());
    await assert.rejects(f.accounts.listDevices(ACCOUNT_ID), { code: 'LOGIN_CANCELLED' });
});

test('warning codes never contain arbitrary SDK messages or credential-like text', () => {
    assert.equal(safeCode(error('TOKEN_EXPIRED')), 'TOKEN_EXPIRED');
    assert.equal(safeCode(error('token=secret user@example.test')), 'CONNECTION_FAILED');
    assert.equal(safeCode(new Error('fixture-password')), 'CONNECTION_FAILED');
});
