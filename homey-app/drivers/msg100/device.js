'use strict';

const Homey = require('homey');
const { CAPABILITY, identity, closedValue, requireGarage, friendlyError } = require('../../lib/garage');
const { safeCode } = require('../../lib/accounts');

const RETRY_MS = 60000;
const CONFIRMATION_MS = 45000;
const CONFIRMATION_POLL_MS = 3000;
const PUBLIC_MESSAGE = Symbol('MSG100 public message');

function positionError(message) {
    const error = new Error(message);
    error[PUBLIC_MESSAGE] = true;
    return error;
}

class Msg100Device extends Homey.Device {
    async onInit() {
        this._closed = false;
        this._generation = 0;
        this._stateQueue = Promise.resolve();
        this._authenticationRequired = false;
        this._identity = identity(this.getData(), this.getStore());
        this._accounts = this.homey.app.accounts;
        this._sessionChanged = account => {
            if ((typeof account === 'string' ? account : account?.accountId) === this._identity.accountId) {
                this._authenticationRequired = false;
                void this.reconnectAccount();
            }
        };
        this._authenticationChanged = account => {
            if ((typeof account === 'string' ? account : account?.accountId) !== this._identity.accountId || this._closed) return;
            this._authenticationRequired = true;
            const generation = ++this._generation;
            this._detach();
            if (this._retryTimer) this.homey.clearTimeout(this._retryTimer);
            this._retryTimer = null;
            void this._queueUpdate(generation, () => this.setUnavailable('Your Meross session has expired. Open this device’s repair screen to sign in again.'))
                .catch(() => this.error('Could not update garage-door availability.'));
        };
        this._accounts.on('session', this._sessionChanged);
        this._accounts.on('authentication', this._authenticationChanged);
        this.registerCapabilityListener(CAPABILITY, value => this.writeClosed(value));
        await this.reconnectAccount();
    }

    _current(generation) {
        return !this._closed && this._generation === generation;
    }

    _detach() {
        this._confirmation?.cancel('The connection changed before the door position was confirmed. Check the door before trying again.');
        if (this._endpoint && this._listeners) {
            for (const [event, handler] of Object.entries(this._listeners)) this._endpoint.off(event, handler);
        }
        this._endpoint = null;
        this._listeners = null;
        this._reported = undefined;
    }

    _queueUpdate(generation, update) {
        const pending = this._stateQueue.catch(() => {}).then(async () => {
            if (this._current(generation)) await update();
        });
        this._stateQueue = pending;
        return pending;
    }

    _reportedChange(generation, endpoint, values) {
        const closed = closedValue(values);
        if (closed !== undefined && this._current(generation)) this._reported = closed;
        return this._queueUpdate(generation, async () => {
            if (closed !== undefined) await this.setCapabilityValue(CAPABILITY, closed);
            if (!this._current(generation)) return;
            if (!endpoint.isOnline()) await this.setUnavailable('The MSG100 is offline. Check its power and Wi-Fi connection.');
            else if (typeof this._reported !== 'boolean') await this.setUnavailable('Waiting for the MSG100 to report its door position.');
            else {
                if (this._retryTimer) this.homey.clearTimeout(this._retryTimer);
                this._retryTimer = null;
                await this.setAvailable();
            }
        });
    }

    _scheduleRetry() {
        if (this._closed || this._authenticationRequired || this._retryTimer) return;
        this._retryTimer = this.homey.setTimeout(() => {
            this._retryTimer = null;
            void this.reconnectAccount();
        }, RETRY_MS);
    }

    async reconnectAccount() {
        if (this._closed || this._authenticationRequired) return false;
        const generation = ++this._generation;
        this._detach();
        if (this._retryTimer) this.homey.clearTimeout(this._retryTimer);
        this._retryTimer = null;
        const previous = this._binding;
        const binding = (async () => {
            await previous?.catch(() => {});
            if (!this._current(generation)) return false;
            await this._queueUpdate(generation, () => this.setUnavailable('Connecting to the MSG100…'));
            const { accountId, uuid, endpointId, ownerId } = this._identity;
            const endpoint = await this._accounts.acquireEndpoint(accountId, uuid, endpointId, ownerId);
            if (!this._current(generation)) return false;
            requireGarage(endpoint);
            this._endpoint = endpoint;
            const change = value => {
                if (value?.trait === 'cover') {
                    void this._reportedChange(generation, endpoint, value.values).catch(() => this.error('Could not update the reported garage-door state.'));
                }
            };
            const availability = online => {
                if (!online && this._current(generation)) this._scheduleRetry();
                void this._reportedChange(generation, endpoint, {}).catch(() => this.error('Could not update garage-door availability.'));
            };
            this._listeners = { change, availability };
            endpoint.on('change', change);
            endpoint.on('availability', availability);
            // Enrollment can emit initial readings before these listeners exist.
            // Enrollment is only a seed. Do not expose stale ready state before
            // the current contact position has been read from the opener.
            await this._refreshPosition(generation, endpoint);
            if (!endpoint.isOnline() || typeof this._reported !== 'boolean') this._scheduleRetry();
            return this._current(generation) && endpoint.isOnline() && typeof this._reported === 'boolean';
        })().catch(async error => {
            if (this._current(generation)) {
                await this._queueUpdate(generation, () => this.setUnavailable(friendlyError(error)));
                this._scheduleRetry();
            }
            return false;
        });
        this._binding = binding;
        return binding;
    }

    async _refreshPosition(generation, endpoint) {
        if (!this._current(generation) || this._endpoint !== endpoint) throw positionError('The garage connection changed.');
        const values = await requireGarage(endpoint).poll();
        if (!this._current(generation) || this._endpoint !== endpoint) throw positionError('The garage connection changed.');
        if (closedValue(values) === undefined) throw positionError('The MSG100 did not report its current door position.');
        // An unchanged GETACK deliberately emits no SDK change event. Its fresh
        // value must still replace Homey's possibly stale capability value.
        await this._reportedChange(generation, endpoint, values);
        if (!this._current(generation) || this._endpoint !== endpoint) throw positionError('The garage connection changed.');
        return values;
    }

    _commandFailure(stage, error, started) {
        this.error(`MSG100 ${stage} failed (${safeCode(error)}, ${Date.now() - started}ms).`);
        // Stack frames identify SDK transport errors versus Homey's own calls.
        // Never log a raw error message, response body, account ID or credential.
        const frames = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 5).filter(line => /^\s+at /.test(line)) : [];
        for (const frame of frames) this.error(frame);
    }

    async writeClosed(closed) {
        if (typeof closed !== 'boolean') throw new Error('Choose whether to open or close the garage door.');
        const endpoint = this._endpoint;
        const generation = this._generation;
        if (this._closed || !endpoint || !endpoint.isOnline() || typeof this._reported !== 'boolean') {
            throw new Error('The MSG100 has no current door position. Wait for it to reconnect before sending a command.');
        }
        if (this._commandPending) throw new Error('A garage-door command is already in progress. Wait for it to finish.');
        const garage = requireGarage(endpoint);
        this._commandPending = true;
        let confirmation;
        let wireSettled = true;
        let finished = false;
        let stage = 'position read';
        const started = Date.now();
        const release = () => {
            if (wireSettled && finished) this._commandPending = false;
        };
        try {
            await this._refreshPosition(generation, endpoint);
            if (!endpoint.isOnline() || typeof this._reported !== 'boolean') throw positionError('The MSG100 did not report its current door position.');
            // Check a fresh read, not the enrollment snapshot: a door opened by
            // another client must not make Close look like an already satisfied request.
            if (this._reported === closed) return;
            confirmation = this._waitForPosition(endpoint, generation, closed);
            wireSettled = false;
            stage = 'command acknowledgment';
            const command = Promise.resolve().then(() => {
                if (!this._current(generation) || !endpoint.isOnline()) throw positionError('The opener disconnected before the command could be sent.');
                return closed ? garage.close() : garage.open();
            }).then(value => {
                wireSettled = true;
                stage = 'position confirmation';
                this.log?.(`MSG100 command acknowledged after ${Date.now() - started}ms; waiting for reported position.`);
                confirmation.acknowledge();
                release();
                return value;
            }, error => {
                wireSettled = true;
                release();
                throw error;
            });
            // Observe reports before sending: a fast PUSH may arrive before SETACK.
            // Promise.all also observes a late wire rejection after cancellation.
            await Promise.all([command, confirmation.promise]);
            if (!this._current(generation)) throw positionError('The connection changed while sending the command. Check the reported door position.');
            const reported = garage.values();
            if (!endpoint.isOnline() || closedValue(reported) !== closed) {
                throw positionError('The door position changed before the command was confirmed. Check the door before trying again.');
            }
            // Homey can apply the requested value after this listener resolves.
            // Resolve only once that value agrees with the opener's actual report.
            await this._reportedChange(generation, endpoint, reported);
            if (!this._current(generation) || !endpoint.isOnline() || closedValue(garage.values()) !== closed) {
                throw positionError('The connection or door position changed before confirmation completed. Check the door before trying again.');
            }
        } catch (error) {
            this._commandFailure(stage, error, started);
            if (error?.[PUBLIC_MESSAGE]) throw error;
            const message = stage === 'position read'
                ? 'Could not read the current MSG100 door position. Check its connection and try again.'
                : 'The MSG100 command failed before its position was confirmed. Check the reported door position before trying again.';
            const publicError = new Error(message);
            publicError.code = safeCode(error);
            throw publicError;
        } finally {
            confirmation?.cleanup();
            finished = true;
            release();
        }
    }

    _waitForPosition(endpoint, generation, closed) {
        let settled = false;
        let acknowledged = false;
        let positionSeen = false;
        let timer;
        let pollTimer;
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        // Cancellation may happen synchronously inside a transport test hook.
        void promise.catch(() => {});
        const cleanup = () => {
            if (timer) this.homey.clearTimeout(timer);
            if (pollTimer) this.homey.clearTimeout(pollTimer);
            timer = null;
            pollTimer = null;
            endpoint.off('change', onChange);
            endpoint.off('availability', onAvailability);
            if (this._confirmation === confirmation) this._confirmation = null;
        };
        const finish = error => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve();
        };
        const onChange = change => {
            if (!this._current(generation)) {
                finish(positionError('The connection changed before the door position was confirmed.'));
            } else if (change?.trait === 'cover' && closedValue(change.values) !== undefined) {
                positionSeen = closedValue(change.values) === closed;
                if (acknowledged && positionSeen) finish();
            }
        };
        const onAvailability = online => {
            if (!online) finish(positionError('The MSG100 disconnected before confirming the door position. Check the door before trying again.'));
        };
        const pollPosition = async () => {
            pollTimer = null;
            if (settled || !this._current(generation)) return;
            const readStarted = Date.now();
            try {
                const values = await this._refreshPosition(generation, endpoint);
                if (settled) return;
                positionSeen = closedValue(values) === closed;
                if (acknowledged && positionSeen) finish();
            } catch (error) {
                if (!settled && this._current(generation)) this._commandFailure('confirmation read', error, readStarted);
            } finally {
                if (!settled && this._current(generation)) pollTimer = this.homey.setTimeout(pollPosition, CONFIRMATION_POLL_MS);
            }
        };
        const confirmation = {
            promise,
            cleanup,
            cancel: message => finish(positionError(message)),
            acknowledge: () => {
                acknowledged = true;
                if (!this._current(generation) || !endpoint.isOnline()) finish(positionError('The connection changed before the door position was confirmed.'));
                else if (positionSeen) finish();
            }
        };
        this._confirmation = confirmation;
        endpoint.on('change', onChange);
        endpoint.on('availability', onAvailability);
        timer = this.homey.setTimeout(() => finish(positionError('The MSG100 did not confirm the door position within 45 seconds. Check the door before trying again.')), CONFIRMATION_MS);
        pollTimer = this.homey.setTimeout(pollPosition, CONFIRMATION_POLL_MS);
        return confirmation;
    }

    async onUninit() {
        if (this._closed) return;
        this._closed = true;
        this._generation++;
        this._accounts?.off('session', this._sessionChanged);
        this._accounts?.off('authentication', this._authenticationChanged);
        if (this._retryTimer) this.homey.clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._detach();
        await this._binding?.catch(() => {});
        await this._stateQueue?.catch(() => {});
        if (this._identity && !this._accounts.closed) {
            const { accountId, uuid, ownerId } = this._identity;
            await this._accounts.releaseEndpoint(accountId, uuid, ownerId);
        }
    }

    async onDeleted() {
        await this.onUninit();
    }
}

module.exports = Msg100Device;
