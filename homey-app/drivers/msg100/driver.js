'use strict';

const Homey = require('homey');
const { randomUUID } = require('node:crypto');
const { isMsg100, pairingDevice, credentials, loginChallenge, friendlyError, identity } = require('../../lib/garage');

class Msg100Driver extends Homey.Driver {
    async onPair(session) {
        let active = true;
        let revision = 0;
        let accountId;
        const discoveries = new Set();
        let candidates = [];
        const accounts = this.homey.app.accounts;
        const releaseDiscovery = async (records = [...discoveries]) => {
            for (const record of records) {
                if (!discoveries.delete(record)) continue;
                await accounts.releaseDiscovery(record.accountId, record.uuids, record.ownerId);
            }
        };
        session.setHandler('getContext', async () => ({ repair: false }));
        session.setHandler('login', async value => {
            if (!active) throw new Error('Pairing is closed. Start adding the MSG100 again.');
            const current = ++revision;
            const isCurrent = () => active && current === revision;
            candidates = [];
            const login = credentials(value);
            try {
                await releaseDiscovery();
                if (!isCurrent()) throw new Error('Pairing is closed. Start adding the MSG100 again.');
                const account = await accounts.login(login, { isCurrent });
                if (!isCurrent()) throw new Error('Pairing is closed. Start adding the MSG100 again.');
                accountId = account.accountId;
                return { status: 'ok' };
            } catch (error) {
                const challenge = loginChallenge(error);
                if (challenge && isCurrent()) return challenge;
                throw new Error(friendlyError(error));
            } finally {
                login.password = '';
                login.mfaCode = '';
            }
        });
        session.setHandler('list_devices', async () => {
            if (!active || !accountId) throw new Error('Sign in to Meross before choosing an opener.');
            const current = revision;
            const isCurrent = () => active && current === revision;
            const selectedAccountId = accountId;
            let physical;
            try {
                physical = (await accounts.listDevices(selectedAccountId)).filter(device => isMsg100(device.model));
            } catch (error) {
                throw new Error(friendlyError(error));
            }
            if (!isCurrent()) return [];
            if (!physical.length) throw new Error('No MSG100 garage openers were found on this Meross account.');
            const discovery = { accountId: selectedAccountId, uuids: physical.map(device => device.uuid), ownerId: `pair:${randomUUID()}` };
            discoveries.add(discovery);
            let rows;
            try {
                rows = await accounts.discover(selectedAccountId, discovery.uuids, discovery.ownerId);
            } catch (error) {
                await releaseDiscovery([discovery]);
                if (!isCurrent()) return [];
                throw new Error(friendlyError(error));
            }
            if (!isCurrent()) {
                await releaseDiscovery([discovery]);
                return [];
            }
            candidates = rows.map(row => physical.map(device => pairingDevice(selectedAccountId, row, device)).find(Boolean)).filter(Boolean);
            if (!candidates.length) throw new Error('Your MSG100 was found, but it is not reporting a reachable garage-door endpoint. Check its power and Wi-Fi, then retry.');
            return candidates.map(device => ({ ...device, data: { ...device.data }, store: { ...device.store }, capabilities: [...device.capabilities] }));
        });
        const cancel = async () => {
            revision++;
            accountId = undefined;
            candidates = [];
            await releaseDiscovery();
            return true;
        };
        session.setHandler('cancel_login', cancel);
        session.setHandler('disconnect', async () => {
            active = false;
            await cancel();
        });
    }

    async onRepair(session, device) {
        let active = true;
        let revision = 0;
        const { accountId } = identity(device.getData(), device.getStore());
        session.setHandler('getContext', async () => ({
            repair: true,
            email: this.homey.app.accounts.getAccountEmail?.(accountId) || ''
        }));
        session.setHandler('login', async value => {
            if (!active) throw new Error('Repair is closed. Open the opener’s repair screen again.');
            const current = ++revision;
            const isCurrent = () => active && current === revision;
            const login = credentials(value);
            try {
                await this.homey.app.accounts.login(login, { expectedAccountId: accountId, isCurrent });
                if (!isCurrent()) throw new Error('Repair is closed. Open the opener’s repair screen again.');
                const connected = await device.reconnectAccount();
                if (!isCurrent()) throw new Error('Repair is closed. Open the opener’s repair screen again.');
                return { status: 'ok', offline: connected !== true };
            } catch (error) {
                const challenge = loginChallenge(error);
                if (challenge && isCurrent()) return challenge;
                throw new Error(friendlyError(error));
            } finally {
                login.password = '';
                login.mfaCode = '';
            }
        });
        session.setHandler('cancel_login', async () => { revision++; return true; });
        session.setHandler('disconnect', async () => { active = false; revision++; });
    }
}

module.exports = Msg100Driver;
