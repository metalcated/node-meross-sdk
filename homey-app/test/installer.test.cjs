'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { test } = require('node:test');
const process = require('node:process');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const appId = 'com.metalcated.meross';
const version = '0.1.0';

function loadInstaller({ validation = true, manifest = { id: appId, version } } = {}) {
    const filename = path.join(root, 'scripts/install-app.cjs');
    const nativeRequire = createRequire(filename);
    const calls = [];
    const archive = { packageArchive: true };
    class App {
        constructor(directory) { calls.push(['construct', directory]); }
        async preprocess() { calls.push(['preprocess']); }
        async _validate() { calls.push(['validate']); return validation; }
        async _getPackStream() { calls.push(['pack']); return archive; }
    }
    const localRequire = request => {
        if (request === 'homey/lib/App') {
            return App;
        }
        if (request === 'node:fs') {
            return { promises: { readFile: async () => JSON.stringify(manifest) } };
        }
        return nativeRequire(request);
    };
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(localRequire, module, module.exports, filename, path.dirname(filename));
    return { ...module.exports, calls, archive };
}

function runningApp(overrides = {}) {
    return { id: appId, version, state: 'running', enabled: true, crashed: false, ...overrides };
}

function homeyDouble() {
    const calls = [];
    return {
        id: 'HOMEY-SELECTED',
        name: 'Selected Homey',
        calls,
        sessions: { getSessionMe: async options => { calls.push(['authenticate', options]); return {}; } },
        devkit: { runApp: async options => { calls.push(['upload', options]); return { appId }; } },
        apps: { getApp: async options => { calls.push(['runtime', options]); return runningApp(); } }
    };
}

function pingResponse({ ok = true, id = 'HOMEY-SELECTED', body = 'true' } = {}) {
    return { ok, headers: { get: name => name.toLowerCase() === 'x-homey-id' ? id : null }, text: async () => body };
}

test('installation uses the packaged archive, preserves app data, and verifies the expected running app', async () => {
    const { installApp, archive, calls } = loadInstaller();
    const homey = homeyDouble();
    const installed = await installApp({ homey, root });
    assert.deepEqual(calls.map(([name]) => name), ['construct', 'preprocess', 'validate', 'pack']);
    const upload = homey.calls.find(([name]) => name === 'upload');
    assert.equal(upload[1].app, archive);
    assert.deepEqual(upload[1].env, {});
    assert.equal(upload[1].debug, false);
    assert.equal(upload[1].clean, false);
    const runtime = homey.calls.find(([name]) => name === 'runtime');
    assert.deepEqual(runtime[1], { id: appId, $cache: false });
    assert.equal(installed.id, appId);
    assert.equal(installed.version, version);
});

test('upload rejection cannot pass because an older app is running', async () => {
    const { installApp } = loadInstaller();
    const homey = homeyDouble();
    homey.devkit.runApp = async () => { throw new Error('Upload rejected'); };
    await assert.rejects(installApp({ homey, root }), /Upload rejected/);
    assert.equal(homey.calls.some(([name]) => name === 'runtime'), false);
});

test('invalid package identity or validation prevents upload', async () => {
    for (const options of [{ validation: false }, { manifest: { id: 'com.meross', version } }]) {
        const { installApp } = loadInstaller(options);
        const homey = homeyDouble();
        await assert.rejects(installApp({ homey, root }), /validat|identity/);
        assert.equal(homey.calls.length, 0);
    }
});

test('a wrong acknowledgment cannot trigger runtime success', async () => {
    const { installApp } = loadInstaller();
    const homey = homeyDouble();
    homey.devkit.runApp = async () => ({ appId: 'com.other.app' });
    await assert.rejects(installApp({ homey, root }), /acknowledge/);
    assert.equal(homey.calls.some(([name]) => name === 'runtime'), false);
});

test('runtime verification rejects wrong version, identity, disabled state, and startup crash', async () => {
    const { verifyInstalled } = loadInstaller();
    for (const overrides of [{ version: '0.0.0' }, { id: 'com.other.app' }, { enabled: false }, { crashed: true }, { state: 'crashed' }]) {
        await assert.rejects(verifyInstalled({ getApp: async () => runningApp(overrides), version, appId }));
    }
});

test('runtime verification waits for startup and times out when the app never runs', async () => {
    const { verifyInstalled } = loadInstaller();
    let time = 0;
    let polls = 0;
    const installed = await verifyInstalled({
        getApp: async () => runningApp({ state: ++polls < 3 ? 'starting' : 'running' }),
        version, appId, now: () => time, pause: async delay => { time += delay; }, timeoutMs: 5000
    });
    assert.equal(installed.state, 'running');
    assert.equal(polls, 3);
    time = 0;
    await assert.rejects(verifyInstalled({
        getApp: async () => runningApp({ state: 'starting' }),
        version, appId, now: () => time, pause: async delay => { time += delay; }, timeoutMs: 2000
    }), /running in time/);
});

test('installation route accepts only local tunnel origins without embedded credentials', () => {
    const { validateInstallUrl } = loadInstaller();
    for (const url of ['http://127.0.0.1:8080', 'https://localhost:8443', 'http://[::1]:8080/', 'http://host.docker.internal:8080']) {
        assert.equal(validateInstallUrl(url), new globalThis.URL(url).origin);
    }
    for (const url of ['https://homey.example.com', 'http://192.0.2.20:8080', 'http://127.0.0.1.evil.example',
        'http://user:password@127.0.0.1:8080', 'http://127.0.0.1:8080/api', 'http://127.0.0.1:8080/?token=test',
        'http://127.0.0.1:8080/#fragment', 'file:///tmp/homey', 'not a URL']) {
        assert.throws(() => validateInstallUrl(url), undefined, url);
    }
});

test('route identity is checked before authenticated requests', async () => {
    const { configureRoute } = loadInstaller();
    const homey = homeyDouble();
    await configureRoute(homey, 'http://127.0.0.1:8080', async (url, options) => {
        assert.equal(homey.calls.length, 0);
        assert.equal(homey.__baseUrlPromise, undefined);
        assert.equal(url, 'http://127.0.0.1:8080/api/manager/system/ping?id=HOMEY-SELECTED');
        assert.deepEqual(options.headers, { 'X-Homey-ID': homey.id });
        assert.equal(options.redirect, 'error');
        return pingResponse();
    });
    assert.deepEqual(homey.calls, [['authenticate', { $cache: false, $socket: false }]]);
    assert.equal(await homey.__baseUrlPromise, 'http://127.0.0.1:8080');
});

test('failed, mismatched, or malformed routes cannot send account authentication', async () => {
    const { configureRoute } = loadInstaller();
    for (const response of [pingResponse({ ok: false }), pingResponse({ id: 'OTHER' }), pingResponse({ id: null }), pingResponse({ body: 'false' })]) {
        const homey = homeyDouble();
        await assert.rejects(configureRoute(homey, 'http://127.0.0.1:8080', async () => response), /selected Homey/);
        assert.equal(homey.__baseUrlPromise, undefined);
        assert.equal(homey.calls.length, 0);
    }
    const homey = homeyDouble();
    await assert.rejects(configureRoute(homey, 'http://127.0.0.1:8080/?secret=value', async () => assert.fail('No request is allowed')));
    assert.equal(homey.calls.length, 0);
});

test('no route override leaves the selected Homey connection unchanged', async () => {
    const { configureRoute } = loadInstaller();
    const homey = homeyDouble();
    await configureRoute(homey, '', async () => assert.fail('No override must make no request'));
    assert.equal(homey.calls.length, 0);
    assert.equal(homey.__baseUrlPromise, undefined);
});

test('the shell installer rejects unsafe volume names, tunnel targets, ports, and arguments before connecting', () => {
    const script = path.join(root, 'scripts/install.sh');
    const environment = {
        ...process.env,
        HOMEY_AUTH_VOLUME: 'homey-meross-unit-test',
        HOMEY_SSH_JUMP: 'foreman.gnet.com',
        HOMEY_SSH_TARGET: 'iot-mgmt',
        HOMEY_TUNNEL_PORT: '14859'
    };
    for (const [args, values, message] of [
        [[], { HOMEY_AUTH_VOLUME: '../auth' }, /Docker volume name/],
        [['--via-foreman'], { HOMEY_SSH_JUMP: '-ProxyCommand=unexpected' }, /Invalid tunnel/],
        [['--via-foreman'], { HOMEY_SSH_TARGET: 'iot-mgmt;unexpected' }, /Invalid tunnel/],
        [['--via-foreman'], { HOMEY_TUNNEL_PORT: '0' }, /between 1 and 65535/],
        [['--via-foreman'], { HOMEY_TUNNEL_PORT: '65536' }, /between 1 and 65535/],
        [['--via-foreman'], { HOMEY_TUNNEL_PORT: 'not-a-port' }, /Invalid tunnel/],
        [['--unknown'], {}, /Usage:/],
        [['--via-foreman', '--extra'], {}, /Usage:/]
    ]) {
        const result = spawnSync('bash', [script, ...args], { env: { ...environment, ...values }, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
        assert.equal(result.stdout, '');
    }
});
