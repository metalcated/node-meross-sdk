import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { Session } from '../src/session';
import { ABILITY_NAMESPACE } from '../src/device';
import {
    GARAGE_CONFIG_NAMESPACE,
    GARAGE_STATE_NAMESPACE,
    SYSTEM_ALL_NAMESPACE,
    decodeMessage,
    encodeMessage,
    type MerossMessage
} from '../src/protocol';
import { CommandError, ProtocolError } from '../src/errors';
import { FakeMqttClient } from './helpers/mqtt';
import { jsonResponse, ok } from './helpers/http';

const UUID = '2206138957096651080248e1e99705a4';
const KEY = 'garage-fixture-key';
const IP = '192.0.2.81';
const NOW = 1_700_000_000_000;

async function advance(t: TestContext, milliseconds: number): Promise<void> {
    t.mock.timers.tick(milliseconds);
    // Exercise the real async Session -> router -> LAN -> dispatcher ->
    // runtime chain before another timer tick, without wall-clock delays.
    for (let index = 0; index < 50; index += 1) {
        await Promise.resolve();
    }
}

async function fixture(t: TestContext, options: {
    cloudModel?: string;
    hardwareModel?: string;
    maxCmdNum?: number;
    /** Omit the new SDK option entirely to exercise its existing default. */
    catalogPolling?: boolean;
} = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
    let open = 0;
    let failState = false;
    let holdState: Promise<void> | undefined;
    let stateResponse: {
        payload: MerossMessage['payload']; namespace?: string; method?: string;
    } | undefined;
    const lan: MerossMessage[] = [];
    const mqtt = new FakeMqttClient();
    const original = JSON.parse(readFileSync(
        join(process.cwd(), 'test/fixtures/system-all-getack.json'), 'utf8'
    )) as MerossMessage;
    const all = original.payload.all as {
        system: { hardware: { type: string }; firmware: { innerIp: string } };
        digest: Record<string, unknown>;
    };
    all.system.hardware.type = options.hardwareModel ?? 'msg100';
    all.system.firmware.innerIp = IP;
    // Deliberately keep the All digest stale. Only a channel-specific
    // Garage.State GET can recover a missing final state PUSH in this fixture.
    all.digest = { garageDoor: [{ channel: 0, open: 0, doorEnable: 1 }] };
    const ability = {
        [SYSTEM_ALL_NAMESPACE]: {},
        [GARAGE_STATE_NAMESPACE]: {},
        [GARAGE_CONFIG_NAMESPACE]: {},
        'Appliance.System.Debug': {},
        'Appliance.System.Position': {},
        'Appliance.System.DNDMode': {},
        'Appliance.Control.Multiple': { maxCmdNum: options.maxCmdNum ?? 5 }
    };

    function reply(sent: MerossMessage): MerossMessage {
        let payload: MerossMessage['payload'] = {};
        if (sent.header.namespace === ABILITY_NAMESPACE) {
            payload = { ability };
        } else if (sent.header.namespace === SYSTEM_ALL_NAMESPACE) {
            payload = original.payload;
        } else if (sent.header.namespace === GARAGE_STATE_NAMESPACE) {
            payload = failState
                ? { error: { code: 5000 } }
                : stateResponse?.payload ?? { state: { channel: 0, open, lmTime: 0 } };
        } else if (sent.header.namespace === GARAGE_CONFIG_NAMESPACE) {
            payload = { config: { signalDuration: 500 } };
        }
        return encodeMessage({
            namespace: sent.header.namespace === GARAGE_STATE_NAMESPACE
                ? stateResponse?.namespace ?? sent.header.namespace : sent.header.namespace,
            method: failState && sent.header.namespace === GARAGE_STATE_NAMESPACE
                ? 'ERROR' : sent.header.namespace === GARAGE_STATE_NAMESPACE
                    ? stateResponse?.method ?? 'GETACK' : 'GETACK',
            key: KEY,
            from: `/appliance/${UUID}/publish`,
            uuid: UUID,
            messageId: sent.header.messageId,
            timestamp: sent.header.timestamp,
            payload
        });
    }
    mqtt.autoAck = (wire) => reply(decodeMessage(wire, KEY));
    const session = Session.restore({
        token: 'garage-fixture-token', key: KEY, userId: '42',
        domain: 'https://example.invalid', mqttDomain: 'example.invalid'
    }, {
        ...(options.catalogPolling ? {} : { garageStatePolling: true }),
        cloud: {
            fetch: async () => ok([{
                uuid: UUID, devName: 'Garage fixture',
                deviceType: options.cloudModel ?? 'msg100', onlineStatus: 1,
                channels: [{ channel: 0, devName: 'Garage fixture' }]
            }])
        },
        mqttConnect: () => {
            queueMicrotask(() => mqtt.emit('connect'));
            return mqtt;
        },
        lanFetch: async (url, init) => {
            assert.equal(String(url), `http://${IP}/config`);
            const sent = decodeMessage(String(init?.body), KEY);
            lan.push(sent);
            if (sent.header.namespace === GARAGE_STATE_NAMESPACE) {
                await holdState;
            }
            return jsonResponse(reply(sent));
        }
    });
    t.after(() => session.disconnect());
    await session.connect();
    const enrollment = await session.enroll([UUID]);
    assert.deepEqual(enrollment.failed, []);
    await advance(t, 0);
    const endpoint = session.endpoint(`${UUID}:0`);
    const garage = endpoint.cover;
    assert.ok(garage?.kind === 'garage');
    return {
        session, endpoint, garage, lan, mqtt,
        setOpen: (value: number) => { open = value; },
        failState: (value: boolean) => { failState = value; },
        stateResponse: (value: typeof stateResponse) => { stateResponse = value; },
        holdState: (promise: Promise<void> | undefined) => { holdState = promise; },
        markMqttActive: () => mqtt.deliver(encodeMessage({
            namespace: SYSTEM_ALL_NAMESPACE, method: 'PUSH', key: KEY,
            from: `/appliance/${UUID}/publish`, uuid: UUID,
            payload: original.payload
        }))
    };
}

describe('MSG100 Session state refresh', () => {
    it('recovers stale contact state over LAN without a PUSH while MQTT is active', async (t) => {
        const device = await fixture(t);
        assert.equal(device.garage.values().open, false);
        const changes: unknown[] = [];
        device.endpoint.on('change', (change) => {
            if (change.trait === 'cover') {
                changes.push(change.values);
            }
        });
        device.markMqttActive();
        device.lan.length = 0;
        device.setOpen(1);

        await advance(t, 30_000);

        assert.equal(device.garage.values().open, true);
        assert.deepEqual(changes, [{ open: true }]);
        assert.deepEqual(device.lan.map((sent) => ({
            namespace: sent.header.namespace, method: sent.header.method,
            payload: sent.payload
        })), [
            { namespace: SYSTEM_ALL_NAMESPACE, method: 'GET', payload: {} },
            { namespace: GARAGE_STATE_NAMESPACE, method: 'GET', payload: { state: { channel: 0 } } }
        ]);
        device.setOpen(0);
        await advance(t, 30_000);
        assert.equal(device.garage.values().open, false);
        assert.deepEqual(changes, [{ open: true }, { open: false }]);
        assert.ok(device.lan.every((sent) => sent.header.method === 'GET'));
    });

    it('coalesces explicit reads, applies real GETACK state, and never sends a SET', async (t) => {
        const device = await fixture(t);
        device.lan.length = 0;
        device.setOpen(1);
        let release!: () => void;
        device.holdState(new Promise<void>((resolve) => { release = resolve; }));
        const first = device.garage.poll();
        const second = device.garage.poll();
        assert.equal(first, second);
        await advance(t, 0);
        assert.equal(device.lan.length, 1);
        assert.equal(device.garage.values().open, false);
        release();
        assert.deepEqual(await first, { open: true });
        assert.deepEqual(await second, { open: true });
        assert.deepEqual(device.lan[0]?.payload, { state: { channel: 0 } });
        assert.equal(device.lan[0]?.header.method, 'GET');
    });

    it('preserves reported state on a failed read and allows the next read to retry', async (t) => {
        const device = await fixture(t);
        device.failState(true);
        const first = device.garage.poll();
        const second = device.garage.poll();
        assert.equal(first, second);
        await assert.rejects(first, (error: unknown) =>
            error instanceof CommandError && error.code === 'COMMAND_FAILED');
        await assert.rejects(second);
        assert.equal(device.garage.values().open, false);
        device.failState(false);
        device.setOpen(1);
        assert.deepEqual(await device.garage.poll(), { open: true });
    });

    it('selects the measured profile from hardware type even with a cloud model override', async (t) => {
        const device = await fixture(t, { cloudModel: 'cloud-alias', hardwareModel: 'MSG100' });
        assert.deepEqual(device.lan.map((sent) => sent.header.namespace), [
            SYSTEM_ALL_NAMESPACE, GARAGE_STATE_NAMESPACE
        ]);
        assert.deepEqual(device.lan[1]?.payload, { state: { channel: 0 } });
    });

    it('rejects another channel, absent contact state, and wrong reply headers without returning cached state', async (t) => {
        const device = await fixture(t);
        device.setOpen(1);
        assert.deepEqual(await device.garage.poll(), { open: true });
        const invalid = [
            { payload: { state: { channel: 1, open: 0 } } },
            { payload: { state: [] } },
            { payload: {} },
            { payload: { state: { channel: 0 } } },
            { payload: { state: { channel: 0, open: '0' } } },
            { payload: { state: { channel: 0, open: 2 } } },
            { payload: { state: [{ channel: 0, open: 1 }, { channel: 0 }] } },
            { payload: { state: { channel: 0, open: 0 } }, method: 'SETACK' },
            {
                payload: { state: { channel: 0, open: 0 } },
                namespace: 'Appliance.System.Debug'
            }
        ];
        for (const response of invalid) {
            device.stateResponse(response);
            await assert.rejects(device.garage.poll(), ProtocolError);
            assert.equal(device.garage.values().open, true);
        }
        device.stateResponse(undefined);
        device.setOpen(0);
        assert.deepEqual(await device.garage.poll(), { open: false });
    });

    it('retains the existing MSG100 optional polling when the host does not opt in', async (t) => {
        const device = await fixture(t, { catalogPolling: true });
        assert.ok(device.lan.some((sent) => sent.header.namespace === GARAGE_CONFIG_NAMESPACE));
        assert.ok(device.lan.some((sent) => sent.header.namespace === 'Appliance.System.Position'));
    });

    it('retains the existing optional poll jobs for a different garage model', async (t) => {
        const device = await fixture(t, {
            cloudModel: 'msg200', hardwareModel: 'msg200', maxCmdNum: 1
        });
        assert.ok(device.lan.some((sent) => sent.header.namespace === GARAGE_CONFIG_NAMESPACE));
        assert.ok(device.lan.some((sent) => sent.header.namespace === 'Appliance.System.Position'));
    });
});
