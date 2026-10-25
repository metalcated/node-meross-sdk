'use strict';

const { EventEmitter } = require('node:events');

const SETTINGS_KEY = 'meross_accounts_v1';
const SESSION_OPTIONS = Object.freeze({ garageStatePolling: true });

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function copyToken(token) {
    const copy = {};
    for (const key of ['token', 'key', 'userId', 'userEmail', 'domain', 'mqttDomain', 'issuedOn']) {
        if (typeof token[key] === 'string') copy[key] = token[key];
    }
    return copy;
}

function uuidOf(endpointId) {
    return endpointId.split(/[:#]/, 1)[0];
}

/** One SDK session per account. Only tokens go into Homey's persistent settings. */
class Accounts extends EventEmitter {
    constructor({ Session, settings, warn = () => {} }) {
        super();
        this.Session = Session;
        this.settings = settings;
        this.warn = warn;
        this.entries = new Map();
        this.records = new Map();
        this.tail = Promise.resolve();
        this.closed = false;
        const saved = settings.get(SETTINGS_KEY);
        if (saved?.version === 1 && Array.isArray(saved.accounts)) {
            for (const record of saved.accounts) {
                if (record && typeof record.id === 'string' && record.token?.userId === record.id) {
                    this.records.set(record.id, {
                        id: record.id,
                        email: typeof record.email === 'string' ? record.email : '',
                        token: copyToken(record.token)
                    });
                }
            }
        }
    }

    getAccountEmail(accountId) {
        return this.records.get(accountId)?.email || '';
    }

    run(operation) {
        const result = this.tail.then(() => {
            this.check();
            return operation();
        });
        this.tail = result.catch(() => {});
        return result;
    }

    check(isCurrent = () => true) {
        if (this.closed || !isCurrent()) throw failure('LOGIN_CANCELLED', 'This login was cancelled.');
    }

    async persist(records) {
        await this.settings.set(SETTINGS_KEY, { version: 1, accounts: [...records.values()] });
    }

    watch(session, accountId) {
        session.on('warning', (error) => {
            if (this.closed || this.entries.get(accountId)?.session !== session) return;
            // Never log a cloud response, credential, user identifier or SDK traffic dump.
            this.warn(`Meross device communication warning (${safeCode(error)}).`);
            if (isAuthenticationError(error)) this.emit('authentication', accountId);
        });
    }

    entry(accountId) {
        let entry = this.entries.get(accountId);
        if (entry) return entry;
        const record = this.records.get(accountId);
        if (!record) throw failure('ACCOUNT_MISSING', 'Sign in again using Repair.');
        let session;
        try {
            session = this.Session.restore(record.token, SESSION_OPTIONS);
        } catch {
            throw failure('TOKEN_EXPIRED', 'Sign in again using Repair.');
        }
        this.watch(session, accountId);
        entry = { session, refs: new Map(), discovery: new Map() };
        this.entries.set(accountId, entry);
        return entry;
    }

    async cleanup(session, logout) {
        try {
            if (logout) await session.logout();
            else await session.disconnect();
        } catch {
            // logout normally disconnects first; still close transports if it failed early.
            try { await session.disconnect(); } catch { /* already disconnected */ }
            this.warn('Meross session cleanup could not be fully confirmed.');
        }
    }

    /** Stage repair independently so a failed candidate cannot replace a working session. */
    login(credentials, { expectedAccountId, isCurrent = () => true } = {}) {
        return this.run(async () => {
            this.check(isCurrent);
            const email = typeof credentials?.email === 'string' ? credentials.email.trim() : '';
            const password = typeof credentials?.password === 'string' ? credentials.password : '';
            const mfaCode = typeof credentials?.mfaCode === 'string' ? credentials.mfaCode.trim() : '';
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
                throw failure('AUTHENTICATION', 'Enter your Meross email address and password.');
            }
            if (mfaCode && !/^\d{6}$/.test(mfaCode)) {
                throw failure('MFA_WRONG', 'Enter the current six-digit authenticator code.');
            }
            let candidate;
            let adopted = false;
            let persisted = false;
            const previousRecords = new Map(this.records);
            try {
                candidate = await this.Session.login({ email, password, ...(mfaCode ? { mfaCode } : {}) }, SESSION_OPTIONS);
                this.check(isCurrent);
                const token = copyToken(candidate.getToken());
                const accountId = token.userId;
                if (typeof accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(accountId)) {
                    throw failure('AUTHENTICATION', 'Meross returned an incomplete account.');
                }
                if (expectedAccountId && accountId !== expectedAccountId) {
                    throw failure('WRONG_ACCOUNT', 'Use the same Meross account that owns this garage opener.');
                }
                await candidate.listDevices();
                this.check(isCurrent);
                await candidate.connect();
                this.check(isCurrent);
                const previous = this.entries.get(accountId);
                const refs = previous?.refs || new Map();
                const discovery = previous?.discovery || new Map();
                const uuids = [...new Set([...refs.values(), ...discovery.keys()])];
                if (uuids.length) {
                    const report = await candidate.enroll(uuids);
                    this.check(isCurrent);
                    // Offline devices retain their Homey identity and retry enrollment later.
                    if (report.failed.length) this.warn('Some Meross devices need another discovery attempt.');
                }
                const nextRecords = new Map(this.records);
                nextRecords.set(accountId, { id: accountId, email, token });
                await this.persist(nextRecords);
                persisted = true;
                this.check(isCurrent);
                this.records = nextRecords;
                this.watch(candidate, accountId);
                this.entries.set(accountId, { session: candidate, refs, discovery });
                adopted = true;
                this.emit('session', accountId);
                if (previous) {
                    let revoke = false;
                    try { revoke = previous.session.getToken().token !== token.token; } catch { /* already invalid */ }
                    await this.cleanup(previous.session, revoke);
                }
                return { accountId };
            } catch (error) {
                if (persisted && !adopted) await this.persist(previousRecords);
                throw error;
            } finally {
                if (candidate && !adopted) {
                    let revoke = false;
                    try {
                        const token = candidate.getToken().token;
                        revoke = ![...previousRecords.values()].some(record => record.token.token === token);
                    } catch { /* no valid credential remains */ }
                    await this.cleanup(candidate, revoke);
                }
            }
        });
    }

    async operation(accountId, operation) {
        try {
            return await operation(this.entry(accountId));
        } catch (error) {
            if (isAuthenticationError(error)) this.emit('authentication', accountId);
            throw error;
        }
    }

    listDevices(accountId) {
        return this.run(() => this.operation(accountId, entry => entry.session.listDevices()));
    }

    discover(accountId, uuids, ownerId = 'pairing') {
        return this.run(() => this.operation(accountId, async entry => {
            const requested = [...new Set(uuids)];
            for (const uuid of requested) {
                if (!entry.discovery.has(uuid)) entry.discovery.set(uuid, new Set());
                entry.discovery.get(uuid).add(ownerId);
            }
            await entry.session.connect();
            this.check();
            const report = await entry.session.enroll(requested);
            this.check();
            const enrolled = new Set(report.enrolled);
            const rows = entry.session.inventory.endpoints().filter(row => enrolled.has(uuidOf(row.id)));
            if (!rows.length && requested.length) {
                const code = report.failed.length ? 'DISCOVERY_FAILED' : 'DEVICE_OFFLINE';
                throw failure(code, 'No garage opener responded. Check its connection and try again.');
            }
            return rows;
        }));
    }

    acquireEndpoint(accountId, uuid, endpointId, ownerId) {
        return this.run(() => this.operation(accountId, async entry => {
            if (uuidOf(endpointId) !== uuid) throw failure('DEVICE_MISMATCH', 'The saved device identity is invalid.');
            entry.refs.set(ownerId, uuid);
            await entry.session.connect();
            this.check();
            const report = await entry.session.enroll([uuid]);
            this.check();
            if (!report.enrolled.includes(uuid)) {
                throw failure(report.failed.length ? 'DISCOVERY_FAILED' : 'DEVICE_OFFLINE', 'Garage opener unavailable.');
            }
            return entry.session.endpoint(endpointId);
        }));
    }

    releaseEndpoint(accountId, uuid, ownerId) {
        return this.run(async () => {
            const entry = this.entries.get(accountId);
            if (!entry) return;
            entry.refs.delete(ownerId);
            if (![...entry.refs.values()].includes(uuid) && !entry.discovery.has(uuid)) {
                await entry.session.unenroll(uuid);
            }
        });
    }

    releaseDiscovery(accountId, uuids, ownerId = 'pairing') {
        return this.run(async () => {
            const entry = this.entries.get(accountId);
            if (!entry) return;
            for (const uuid of uuids) {
                const owners = entry.discovery.get(uuid);
                owners?.delete(ownerId);
                if (!owners?.size) entry.discovery.delete(uuid);
                if (![...entry.refs.values()].includes(uuid) && !entry.discovery.has(uuid)) {
                    await entry.session.unenroll(uuid);
                }
            }
        });
    }

    async close() {
        this.closed = true;
        await this.tail;
        await Promise.allSettled([...this.entries.values()].map(entry => this.cleanup(entry.session, false)));
        this.entries.clear();
        this.removeAllListeners();
    }
}

function safeCode(error) {
    return /^[A-Z_]{1,40}$/.test(error?.code || '') ? error.code : 'CONNECTION_FAILED';
}

function isAuthenticationError(error) {
    return ['TOKEN_EXPIRED', 'AUTHENTICATION', 'ACCOUNT_MISSING'].includes(error?.code);
}

module.exports = { Accounts, SETTINGS_KEY, failure, safeCode };
