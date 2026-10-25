'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { CAPABILITY, STATE_CAPABILITY, OPEN_CAPABILITY, CLOSE_CAPABILITY, DEVICE_CAPABILITIES } = require('../lib/garage');
const manifest = require('../app.json');

test('door UI separates reported status from stateless controls and preserves legacy Flow metadata', () => {
    const driver = manifest.drivers.find(value => value.id === 'msg100');
    assert.deepEqual(driver.capabilities, [...DEVICE_CAPABILITIES]);
    const status = manifest.capabilities[STATE_CAPABILITY];
    assert.equal(status.getable, true);
    assert.equal(status.setable, false);
    assert.equal(status.uiComponent, 'sensor');
    assert.deepEqual(status.values.map(value => [value.id, value.title.en]), [['closed', 'Closed'], ['open', 'Open']]);
    assert.equal(driver.capabilitiesOptions[CAPABILITY].uiComponent, null);
    for (const capability of [CAPABILITY, OPEN_CAPABILITY, CLOSE_CAPABILITY]) {
        assert.equal(driver.capabilitiesOptions[capability].uiQuickAction, false, 'tapping the device tile must not send a garage command');
    }
    assert.equal(driver.capabilitiesOptions[CAPABILITY].preventTag, undefined);
    assert.equal(driver.capabilitiesOptions[CAPABILITY].preventInsights, undefined);
    for (const action of manifest.flow.actions) {
        assert.equal(action.args[0].filter, 'driver_id=msg100');
        assert.match(action.hint.en, /accepts the command/);
    }
    assert.equal(manifest.version, require('../package.json').version);
});

test('explicit Open and Close Flow actions use acknowledged controls and propagate failures', async () => {
    const filename = path.join(__dirname, '../app.js');
    const module = { exports: {} };
    const scopedRequire = name => {
        if (name === 'homey') return { App: class {} };
        if (name === 'node-meross-sdk') return { Session: {} };
        return require(path.resolve(path.dirname(filename), name));
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: scopedRequire, module, exports: module.exports }, { filename });
    const app = new module.exports();
    const listeners = new Map();
    app.homey = {
        settings: { get() {} },
        flow: { getActionCard(id) { return { registerRunListener(listener) { listeners.set(id, listener); } }; } }
    };
    app.log = () => {};
    app.error = () => {};
    await app.onInit();
    assert.deepEqual([...listeners.keys()].sort(), manifest.flow.actions.map(action => action.id).sort());
    const targets = [];
    const device = { async requestClosed(closed) { targets.push(closed); } };
    await listeners.get('garage_open')({ device });
    await listeners.get('garage_close')({ device });
    assert.deepEqual(targets, [false, true]);
    const failure = new Error('The MSG100 is offline.');
    await assert.rejects(listeners.get('garage_open')({ device: { async requestClosed() { throw failure; } } }), error => error === failure);
    await app.onUninit();
    assert.equal(app.accounts.closed, true);
});
