'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const process = require('node:process');
const { Buffer } = require('node:buffer');
const { createRequire } = require('node:module');
const { gunzipSync } = require('node:zlib');
const { installApp } = require('./install-app.cjs');

const root = path.resolve(__dirname, '..');
const sdkRoot = process.env.MEROSS_SDK_BUILD_ROOT || path.resolve(root, '..');

function archiveEntries(archive) {
    const entries = new Map();
    for (let offset = 0; offset + 512 <= archive.length;) {
        const header = archive.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
        if (!name) {
            break;
        }
        const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
        const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
        assert(Number.isSafeInteger(size) && size >= 0, 'The package contains an invalid archive entry');
        assert(offset + 512 + size <= archive.length, 'The package contains a truncated archive entry');
        entries.set((prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ''), archive.subarray(offset + 512, offset + 512 + size));
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
}

function verifyCompiledSdk(entries) {
    const declared = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
    const prefix = 'node_modules/node-meross-sdk/';
    assert(entries.has(`${prefix}package.json`), 'The locally built Meross SDK package is missing');
    const shipped = JSON.parse(entries.get(`${prefix}package.json`).toString());
    assert.equal(declared.dependencies['node-meross-sdk'], sdkPackage.version, 'The app dependency must match the checked-out SDK version');
    assert.equal(shipped.name, 'node-meross-sdk');
    assert.equal(shipped.version, sdkPackage.version);
    let compared = 0;
    function compare(directory, relative = '') {
        for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
            const childRelative = relative ? `${relative}/${file.name}` : file.name;
            const absolute = path.join(directory, file.name);
            if (file.isDirectory()) {
                compare(absolute, childRelative);
            } else if (file.isFile()) {
                const target = `${prefix}dist/${childRelative}`;
                assert(entries.has(target), `The compiled checkout is missing from the archive: ${target}`);
                assert(entries.get(target).equals(fs.readFileSync(absolute)), `The package contains a different SDK build: ${target}`);
                compared++;
            }
        }
    }
    compare(path.join(sdkRoot, 'dist'));
    assert(compared > 0, 'No compiled SDK files were checked');
    assert(entries.has(`${prefix}LICENSE`), 'The SDK license must be included');
    assert(![...entries.keys()].some(file => file.startsWith(`${prefix}src/`) || file.startsWith(`${prefix}test/`)), 'SDK development sources entered the runtime package');
    const runtimeRequire = createRequire(path.join(root, '.homeybuild', 'app.js'));
    const { Session } = runtimeRequire('node-meross-sdk');
    assert.equal(typeof Session.login, 'function');
    assert.equal(typeof Session.restore, 'function');
    assert.equal(typeof Session.prototype.reauthenticate, 'function');
    return compared;
}

async function main() {
    let checked = false;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    await installApp({ root, homey: {
        name: 'Packaging verification',
        apps: { async getApp() { return { id: manifest.id, version: manifest.version, state: 'running', enabled: true }; } },
        devkit: { async runApp({ app: stream, clean, debug }) {
            assert.equal(clean, false);
            assert.equal(debug, false);
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const archive = gunzipSync(Buffer.concat(chunks));
            const entries = archiveEntries(archive);
            const files = [...entries.keys()];
            for (const required of ['app.json', 'app.js', 'assets/icon.svg', 'LICENSE',
                'lib/garage.js', 'lib/accounts.js', 'node_modules/node-meross-sdk/dist/index.js', 'node_modules/mqtt/package.json']) {
                assert(entries.has(required), `Missing runtime file: ${required}`);
            }
            const shippedManifest = JSON.parse(entries.get('app.json').toString());
            const garageDriver = shippedManifest.drivers.find(driver => driver.id === 'msg100');
            assert(garageDriver, 'The packaged MSG100 driver is missing');
            for (const capability of ['garage_door_state', 'button.open', 'button.close', 'garagedoor_closed']) {
                assert(garageDriver.capabilities.includes(capability), `The packaged garage capability is missing: ${capability}`);
            }
            assert.equal(shippedManifest.capabilities.garage_door_state.setable, false, 'The packaged door sensor must be read-only');
            assert.equal(garageDriver.capabilitiesOptions.garagedoor_closed.uiComponent, null, 'The packaged legacy toggle must stay hidden');
            for (const capability of ['garagedoor_closed', 'button.open', 'button.close']) {
                assert.equal(garageDriver.capabilitiesOptions[capability].uiQuickAction, false, 'The package must disable garage tile quick actions');
            }
            for (const id of ['garage_open', 'garage_close']) {
                assert(shippedManifest.flow.actions.some(action => action.id === id), `The packaged Flow action is missing: ${id}`);
            }
            for (const driver of manifest.drivers) {
                for (const kind of ['pair', 'repair']) {
                    const views = driver[kind] || [];
                    for (const view of views.filter(view => !view.template)) {
                        const filename = `drivers/${driver.id}/${kind}/${view.id}.html`;
                        assert(entries.has(filename), `The ${kind} view is missing from the install archive: ${filename}`);
                    }
                }
                for (const filename of ['driver.js', 'device.js']) {
                    assert(entries.has(`drivers/${driver.id}/${filename}`), `Driver runtime is missing: ${driver.id}/${filename}`);
                }
            }
            assert(!files.some(file => /^(test|scripts|\.homeybuild|\.github|\.git|\.homey|vendor)\//.test(file)), 'Source, tooling, or cached artifacts entered the package');
            const tooling = files.filter(file => /^node_modules\/(sharp|homey-api|inquirer|dockerode|typescript|tsx|eslint)\//.test(file));
            assert.equal(tooling.length, 0, `Installer dependencies entered the runtime package: ${tooling.slice(0, 4).join(', ')}`);
            // Homey adds only its runtime shim here; the installer stays outside /app.
            const shimFiles = ['index.js', 'package.json'];
            assert(files.filter(file => file.startsWith('node_modules/homey/')).every(file =>
                file === 'node_modules/homey/' || shimFiles.some(name => file === `node_modules/homey/${name}`)), 'Only the Homey SDK shim may enter the package');
            const shimTemplate = path.join(path.dirname(require.resolve('homey/package.json')), 'assets/homey');
            for (const filename of shimFiles) {
                const entry = `node_modules/homey/${filename}`;
                assert(entries.has(entry), `The Homey runtime shim is missing ${filename}`);
                assert(entries.get(entry).equals(fs.readFileSync(path.join(shimTemplate, filename))), 'The Homey runtime shim differs from the pinned CLI template');
            }
            for (const excluded of ['Dockerfile', '.dockerignore', '.gitignore', '.homeyignore', '.npmrc', '.env', 'env.json', 'package-lock.json']) {
                assert(!entries.has(excluded), `${excluded} must not enter the install archive`);
            }
            const sdkFiles = verifyCompiledSdk(entries);
            assert(archive.length < 40 * 1024 * 1024, 'The runtime archive is unexpectedly large');
            globalThis.console.log(`Verified installation archive: ${entries.size} entries, ${archive.length} bytes unpacked, ${sdkFiles} SDK files match this checkout`);
            checked = true;
            return { appId: manifest.id };
        } }
    } });
    assert(checked, 'The actual installation archive was not verified');
    await assert.rejects(installApp({ root, homey: {
        name: 'Rejected upload verification',
        devkit: { async runApp({ app: stream }) { stream.destroy(); throw new Error('Intentional upload rejection'); } },
        apps: { getApp() { assert.fail('An existing app must not hide an upload rejection'); } }
    } }), /Intentional upload rejection/);
    globalThis.console.log('Upload rejection propagates before runtime verification');
}

if (require.main === module) {
    main().catch(error => {
        globalThis.console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { archiveEntries, verifyCompiledSdk };
