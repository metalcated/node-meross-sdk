'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'drivers/msg100/pair/connect.html'), 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];

async function harness({ repair = false, login = async () => ({ status: 'ok' }) } = {}) {
    const elements = new Map();
    for (const id of ['meross-login', 'email', 'password', 'mfa-code', 'mfa-group', 'login-error', 'login-status', 'continue', 'cancel']) {
        elements.set(id, { value: '', hidden: ['mfa-group', 'login-error'].includes(id), disabled: false,
            textContent: '', required: false, listeners: {},
            addEventListener(event, handler) { this.listeners[event] = handler; },
            focus() { this.focused = true; },
            reportValidity() { return this.valid !== false; }
        });
    }
    const calls = [];
    let done = 0;
    let shown = '';
    const Homey = {
        setTitle() {},
        async emit(event, value) {
            calls.push({ event, value });
            if (event === 'getContext') return { repair, email: repair ? 'owner@example.com' : '' };
            if (event === 'login') return login(value);
            return true;
        },
        async showView(view) { shown = view; },
        async done() { done++; }
        // Deliberately no alert(), confirm(), prompt() or browser storage.
    };
    vm.runInNewContext(script, { Homey, document: { getElementById: id => elements.get(id) } });
    await Promise.resolve();
    await Promise.resolve();
    elements.get('email').value ||= 'owner@example.com';
    elements.get('password').value = 'account-password';
    return {
        elements, calls,
        submit: () => elements.get('meross-login').listeners.submit({ preventDefault() {} }),
        cancel: () => elements.get('cancel').listeners.click(),
        get done() { return done; },
        get shown() { return shown; }
    };
}

test('the actual pairing modal handles MFA and fresh-code retry, then clears secrets before discovery', async () => {
    const responses = ['mfa_required', 'mfa_wrong', 'ok'];
    const ui = await harness({ login: async () => ({ status: responses.shift() }) });
    await ui.submit();
    assert.equal(ui.elements.get('mfa-group').hidden, false);
    assert.equal(ui.elements.get('mfa-code').required, true);
    assert.equal(ui.elements.get('password').value, 'account-password');
    assert.equal(ui.elements.get('mfa-code').focused, true);
    ui.elements.get('mfa-code').value = '000001';
    await ui.submit();
    assert.match(ui.elements.get('login-error').textContent, /fresh code/);
    assert.equal(ui.elements.get('mfa-code').value, '');
    ui.elements.get('mfa-code').value = '012345';
    await ui.submit();
    const logins = ui.calls.filter(call => call.event === 'login');
    assert.equal(logins[0].value.mfaCode, undefined);
    assert.equal(logins[1].value.mfaCode, '000001');
    assert.equal(logins[2].value.mfaCode, '012345');
    assert.equal(ui.elements.get('password').value, '');
    assert.equal(ui.elements.get('mfa-code').value, '');
    assert.equal(ui.shown, 'list_devices');
    assert.equal(ui.done, 0);
});

test('connection errors stay in the modal and allow another attempt', async () => {
    let attempts = 0;
    const ui = await harness({ login: async () => {
        if (++attempts === 1) throw new Error('Could not connect to Meross. Try again.');
        return { status: 'ok' };
    } });
    await ui.submit();
    assert.equal(ui.elements.get('login-error').hidden, false);
    assert.match(ui.elements.get('login-error').textContent, /Could not connect/);
    assert.equal(ui.elements.get('continue').disabled, false);
    await ui.submit();
    assert.equal(ui.shown, 'list_devices');
});

test('canceling an in-flight login clears the form and ignores late success', async () => {
    let complete;
    const ui = await harness({ login: () => new Promise(resolve => { complete = resolve; }) });
    const pending = ui.submit();
    await Promise.resolve();
    await ui.cancel();
    complete({ status: 'ok' });
    await pending;
    assert.equal(ui.elements.get('password').value, '');
    assert.equal(ui.elements.get('mfa-code').value, '');
    assert(ui.calls.some(call => call.event === 'cancel_login'));
    assert.equal(ui.done, 1);
    assert.equal(ui.shown, '');
});

test('repair prefills the account and completes without adding another device', async () => {
    const ui = await harness({ repair: true, login: async () => ({ status: 'ok', offline: true }) });
    assert.equal(ui.elements.get('email').value, 'owner@example.com');
    await ui.submit();
    assert.equal(ui.done, 1);
    assert.equal(ui.shown, '');
    assert.equal(ui.elements.get('password').value, '');
});

test('invalid forms and duplicate submissions cannot create extra login attempts', async () => {
    let complete;
    const ui = await harness({ login: () => new Promise(resolve => { complete = resolve; }) });
    ui.elements.get('meross-login').valid = false;
    await ui.submit();
    assert.equal(ui.calls.filter(call => call.event === 'login').length, 0);
    ui.elements.get('meross-login').valid = true;
    const first = ui.submit();
    await ui.submit();
    assert.equal(ui.calls.filter(call => call.event === 'login').length, 1);
    complete({ status: 'ok' });
    await first;
});

test('pairing and repair use the same tested login modal', () => {
    assert.equal(fs.readFileSync(path.join(root, 'drivers/msg100/repair/connect.html'), 'utf8'), page);
});
