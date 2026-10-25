'use strict';

const path = require('node:path');
const fs = require('node:fs');
const process = require('node:process');
const { setTimeout: sleep } = require('node:timers/promises');

async function verifyInstalled({ getApp, version, appId, now = Date.now,
    pause = sleep, timeoutMs = 30000 }) {
    const until = now() + timeoutMs;
    do {
        const app = await getApp();
        if (!app || app.version !== version) {
            throw new Error('Homey did not install the expected Meross Connect version.');
        }
        if (app.id !== appId) {
            throw new Error('Homey did not return the expected application identity.');
        }
        if (app.crashed || app.state === 'crashed') {
            throw new Error(`Meross Connect failed to start: ${app.crashedMessage || 'check Homey app logs'}`);
        }
        if (app.enabled === false) {
            throw new Error('The installed Meross Connect app is disabled.');
        }
        if (app.state === 'running') {
            return app;
        }
        await pause(1000);
    } while (now() < until);
    throw new Error('Meross Connect was installed but Homey did not report it running in time.');
}

function validateInstallUrl(value) {
    const url = new globalThis.URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('The installation override must be a localhost tunnel address without credentials or a path.');
    }
    return url.origin;
}

async function configureRoute(homey, value, fetchImpl = globalThis.fetch) {
    if (!value) {
        return;
    }
    const origin = validateInstallUrl(value);
    const response = await fetchImpl(`${origin}/api/manager/system/ping?id=${encodeURIComponent(homey.id)}`, {
        headers: { 'X-Homey-ID': homey.id }, redirect: 'error', signal: globalThis.AbortSignal.timeout(5000)
    });
    if (!response.ok || response.headers.get('x-homey-id') !== homey.id || (await response.text()).trim() !== 'true') {
        throw new Error('The tunnel does not lead to the selected Homey.');
    }
    // The pinned CLI uses this same per-instance routing override. Account
    // authentication remains in its existing store rather than an exported key.
    homey.__baseUrlPromise = Promise.resolve(origin);
    await homey.sessions.getSessionMe({ $cache: false, $socket: false });
}

async function installApp({ homey, root = path.resolve(__dirname, '..') }) {
    const App = require('homey/lib/App');
    const app = new App(root);
    await app.preprocess();
    if (await app._validate() !== true) {
        throw new Error('The app did not pass Homey validation.');
    }
    const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'app.json'), 'utf8'));
    if (manifest.id !== 'com.metalcated.meross') {
        throw new Error('The package does not contain the expected Meross Connect app identity.');
    }
    const archive = await app._getPackStream();
    globalThis.console.log(`Installing ${manifest.id} ${manifest.version} on ${homey.name}`);
    // CLI 4.6.1 can report a successful process exit after an upload rejection.
    // Call the same endpoint directly, preserve app data, then verify runtime.
    const uploaded = await homey.devkit.runApp({ app: archive, env: {}, debug: false, clean: false });
    if (!uploaded || uploaded.appId !== manifest.id) {
        throw new Error('Homey did not acknowledge the expected app installation.');
    }
    const installed = await verifyInstalled({ version: manifest.version, appId: manifest.id,
        getApp: () => homey.apps.getApp({ id: manifest.id, $cache: false }) });
    globalThis.console.log(`Verified ${installed.id} ${installed.version}: running on ${homey.name}`);
    return installed;
}

async function main() {
    const api = require('homey/services/AthomApi');
    const homey = await api.getActiveHomey();
    if (process.env.HOMEY_ID && homey.id !== process.env.HOMEY_ID) {
        throw new Error('The selected Homey does not match HOMEY_ID. Select the intended Homey and retry.');
    }
    await configureRoute(homey, process.env.HOMEY_INSTALL_URL);
    await installApp({ homey });
}

if (require.main === module) {
    main().then(() => process.exit(0)).catch(error => {
        globalThis.console.error(error.message);
        process.exit(1);
    });
}

module.exports = { verifyInstalled, validateInstallUrl, configureRoute, installApp };
