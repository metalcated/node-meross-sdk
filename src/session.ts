import { EventEmitter } from 'node:events';

import { CloudClient } from './cloud';
import type { CloudClientOptions, CloudDevice } from './cloud';
import { Board } from './device/board';
import { Endpoint } from './device/endpoint';
import { AuthError, MerossError } from './errors';
import { Inventory } from './inventory';
import type { LogLevel, SessionLogger } from './log';
import {
    DEFAULT_POLL_INTERVAL_MS,
    POLL_START_STAGGER_MS
} from './poll';
import { ProtocolDispatcher } from './protocol/dispatcher';
import { uuidFromHeader, type MerossMessage } from './protocol/message';
import {
    LanHttpTransport,
    MqttTransport,
    TransportRouter,
    type MqttConnectFn
} from './transport';

export interface LoginOptions {
    email: string;
    password: string;
    mfaCode?: string;
}

export interface TokenData {
    token: string;
    key: string;
    userId: string;
    userEmail?: string;
    domain: string;
    mqttDomain: string;
    issuedOn?: string;
}

/**
 * Test hooks and host overrides. Transports stay internal; only cloud `fetch`,
 * MQTT connect, and LAN `fetch` are injectable so CI can run without a broker.
 */
export interface SessionOptions {
    cloud?: CloudClientOptions;
    mqttConnect?: MqttConnectFn;
    lanFetch?: typeof globalThis.fetch;
    /**
     * Opt in to channel-specific MSG100 contact-state reads every LAN tick,
     * limited to System.All and Garage.State. Default catalog polling is
     * unchanged when omitted, including optional configuration refreshes.
     */
    garageStatePolling?: boolean;
    /**
     * Single host sink. Not a field on {@link CloudClientOptions}; login/restore
     * copy it onto the internal cloud client so sign-in is visible.
     */
    logger?: SessionLogger;
    /** Floor when `logger` is set; omitted means `debug` at emit time. */
    logLevel?: LogLevel;
}

/**
 * Physical devices on the account, not enrolled {@link Inventory} rows.
 * `name`/`model` match InventoryRow; identity is `uuid` (inventory `id` is `{uuid}:0`).
 */
export type DeviceList = readonly {
    uuid: string;
    name: string;
    model: string;
    /** Regional / plug-form variant from cloud `subType` (e.g. `eu`, `us`). */
    subType: string;
    onlineStatus: number;
    channels: readonly unknown[];
}[];

/** Why {@link Session.enroll} did not contact this uuid. */
export type EnrollSkipReason = 'offline' | 'unknown';

export interface EnrollSkip {
    readonly uuid: string;
    readonly reason: EnrollSkipReason;
}

export interface EnrollFailure {
    readonly uuid: string;
    readonly error: Error;
}

/**
 * Outcome of one {@link Session.enroll} call. The promise still fulfills when
 * some uuids skip or fail; {@link failed} matches `warning` for reachable
 * Ability / System.All errors. Offline and unknown uuids are only in
 * {@link skipped} (no event). Already-enrolled uuids are in {@link enrolled}.
 */
export interface EnrollReport {
    readonly enrolled: readonly string[];
    readonly skipped: readonly EnrollSkip[];
    readonly failed: readonly EnrollFailure[];
}

type DeviceEnrollOutcome =
    | { status: 'enrolled'; uuid: string }
    | { status: 'failed'; uuid: string; error: Error }
    | { status: 'closed'; uuid: string };

interface MutableEnrollReport {
    enrolled: string[];
    skipped: EnrollSkip[];
    failed: EnrollFailure[];
}

interface SessionEvents {
    connection: [connected: boolean];
    ratelimit: [uuid: string, dropped: number];
    /**
     * Per-device failure {@link Session.enroll} swallowed to keep going. Typical
     * cases are an Ability / System.All timeout, or a hub cloud
     * `listSubDevices` failure (digest children still enroll; cloud names /
     * extra ids are omitted). Cloud-level failures still reject the call
     * itself, so a stale token surfaces there rather than here.
     *
     * `uuid` is the physical device when known. Deliberately not named `error`:
     * Node throws on an unhandled `error` emit, which would turn one
     * unreachable device into a crashed host process.
     */
    warning: [error: Error, uuid?: string];
}

/**
 * Enrollment is two round trips per device, so running devices one after another
 * makes a large account take minutes; unbounded would put every device's Ability
 * GET on the wire at once.
 */
const ENROLL_CONCURRENCY = 4;

/**
 * Inventory ids are `{uuid}:{channel}`, `{uuid}#{subDeviceId}`, or a bare
 * hub-parent `uuid`.
 */
function uuidFromInventoryId(id: string): string {
    const sep = id.search(/[:#]/);
    return sep === -1 ? id : id.slice(0, sep);
}

/**
 * Cloud credentials plus live inventory. Hosts persist {@link TokenData}
 * and rebuild a session with {@link Session.restore}.
 */
export class Session extends EventEmitter<SessionEvents> {
    readonly inventory: Inventory;

    private readonly cloud: CloudClient;
    private token: TokenData;
    private readonly mqttConnect?: MqttConnectFn;
    private readonly lanFetch?: typeof globalThis.fetch;
    private readonly garageStatePolling: boolean;
    private readonly logger?: SessionLogger;
    private readonly logLevel?: LogLevel;
    /** One board per enrolled physical uuid. */
    private readonly boards = new Map<string, Board>();
    /** Monotonic so devices enrolled later keep spreading their ticks. */
    private startedDevices = 0;
    private router: TransportRouter | undefined;
    /**
     * Handshake of the {@link Session.connect} that opened {@link router}.
     * `router` is assigned before it settles, so a concurrent connect must
     * await this rather than read a set `router` as "already connected".
     */
    private connecting: Promise<void> | undefined;
    /**
     * One Ability / System.All pass per uuid. Concurrent {@link enroll} callers
     * for the same uuid join this promise instead of starting a second pass.
     */
    private readonly enrolling = new Map<string, Promise<DeviceEnrollOutcome>>();
    /**
     * Shared cloud `devList` for overlapping {@link enroll} calls. Cleared in
     * `finally` so a later enroll lists again.
     */
    private listing: Promise<CloudDevice[]> | undefined;
    /**
     * Settles when every {@link enroll} in the list-or-register phase has
     * registered its per-uuid passes, so {@link unenroll} cannot finish during
     * the shared `devList` gap before `enrolling` has an entry.
     */
    private listingBarrier: Promise<void> | undefined;
    private releaseListingBarrier: (() => void) | undefined;
    /** {@link enroll} callers still inside list-or-register. */
    private listingPending = 0;
    /** Slots held under {@link withEnrollSlot}; capped by {@link ENROLL_CONCURRENCY}. */
    private activeEnrolls = 0;
    /** Resolvers waiting for a free {@link withEnrollSlot} slot. */
    private readonly enrollWaiters: Array<() => void> = [];
    /**
     * Set for the whole {@link disconnect}, including the wait for in-flight
     * enrolls. Those passes must not start pollers after transports tear down.
     */
    private closing = false;
    /** Shared by overlapping {@link disconnect} calls so teardown runs once. */
    private disconnectPromise: Promise<void> | undefined;
    /** False after {@link logout}; {@link getToken} rejects until {@link reauthenticate}. */
    private credentialsValid = true;

    private constructor(
        token: TokenData,
        cloud: CloudClient,
        options: SessionOptions = {}
    ) {
        super();
        this.token = token;
        this.cloud = cloud;
        this.mqttConnect = options.mqttConnect;
        this.lanFetch = options.lanFetch;
        this.garageStatePolling = options.garageStatePolling ?? false;
        this.logger = options.logger;
        this.logLevel = options.logLevel;
        this.inventory = new Inventory();
    }

    /**
     * Password is not stored; only {@link TokenData} is kept for {@link restore}.
     */
    static async login(
        options: LoginOptions,
        sessionOptions: SessionOptions = {}
    ): Promise<Session> {
        const cloud = await CloudClient.login(options, {
            ...sessionOptions.cloud,
            logger: sessionOptions.logger,
            logLevel: sessionOptions.logLevel
        });
        return new Session(cloud.getToken(), cloud, sessionOptions);
    }

    /**
     * Rebuilds a session from a stored token without a password.
     */
    static restore(token: TokenData, sessionOptions: SessionOptions = {}): Session {
        const cloud = CloudClient.restore(token, {
            ...sessionOptions.cloud,
            logger: sessionOptions.logger,
            logLevel: sessionOptions.logLevel
        });
        return new Session(cloud.getToken(), cloud, sessionOptions);
    }

    /**
     * Returns a copy so callers can persist the token without mutating session state.
     */
    getToken(): TokenData {
        if (!this.credentialsValid) {
            throw new AuthError('Not authenticated');
        }
        return { ...this.token };
    }

    /**
     * Opens MQTT and LAN. Membership is separate: call {@link enroll} afterward.
     * A failed attempt clears the router so a later call can retry. Once open,
     * a second call joins an in-flight handshake, then returns. After
     * {@link logout}, rejects with {@link AuthError}.
     */
    async connect(): Promise<void> {
        if (!this.credentialsValid) {
            throw new AuthError('Not authenticated');
        }
        if (this.router) {
            // Settled once connected, so this only waits for a first connect
            // that is still mid-handshake.
            await this.connecting;
            this.throwIfNotConnected();
            return;
        }
        const router = this.createRouter();
        this.router = router;
        this.connecting = router.connect();
        try {
            await this.connecting;
        } catch (error) {
            await this.disconnectRouter();
            throw error;
        }
    }

    /**
     * Swaps in fresh cloud credentials without discarding inventory, so a host
     * that hits `TOKEN_EXPIRED` can recover in place instead of rebuilding every
     * Endpoint and re-registering its listeners. Transports are only replaced
     * when the broker credentials actually changed, and the old router stays
     * live until the new one connects.
     */
    async reauthenticate(options: LoginOptions): Promise<TokenData> {
        const previous = this.token;
        this.token = await this.cloud.authenticate(options);
        this.credentialsValid = true;
        const stale = this.router;
        if (
            !stale
            || (
                this.token.key === previous.key
                && this.token.userId === previous.userId
                && this.token.mqttDomain === previous.mqttDomain
            )
        ) {
            return this.getToken();
        }

        const fresh = this.createRouter();
        await fresh.connect();
        this.router = fresh;
        await stale.disconnect();
        return this.getToken();
    }

    /**
     * HTTP `devList` only — no MQTT, Ability, or inventory mutation.
     * Hosts use this for pairing UIs; {@link inventory} is the enrolled set.
     */
    async listDevices(): Promise<DeviceList> {
        const cloudDevices = await this.cloud.listDevices();
        return cloudDevices.map((cloudDevice) => ({
            uuid: cloudDevice.uuid,
            name: cloudDevice.devName,
            model: cloudDevice.deviceType,
            subType: cloudDevice.subType ?? '',
            onlineStatus: cloudDevice.onlineStatus,
            channels: [...cloudDevice.channels]
        }));
    }

    /**
     * Adds online cloud devices to inventory. Additive and idempotent: a uuid
     * already enrolled (or mid-pass) does not list the account or contact the
     * device again. Concurrent callers share one in-flight `devList` and one
     * Ability / System.All pass per uuid; passes are bounded by
     * {@link ENROLL_CONCURRENCY} across calls. Omit `uuids` to enroll every
     * online device not yet enrolled; pass `[]` to enroll nothing. Offline rows
     * and uuids absent from the account are in {@link EnrollReport.skipped};
     * a reachable device that fails is in {@link EnrollReport.failed} and on
     * `warning` (with that uuid) while the rest continue.
     */
    async enroll(uuids?: readonly string[]): Promise<EnrollReport> {
        this.throwIfNotConnected();
        await this.connecting;
        this.throwIfNotConnected();

        const report: MutableEnrollReport = { enrolled: [], skipped: [], failed: [] };
        const requested = uuids === undefined ? undefined : new Set(uuids);
        const joined: Promise<DeviceEnrollOutcome>[] = [];
        const pending = new Set<string>();

        if (requested !== undefined) {
            for (const uuid of requested) {
                const inFlight = this.enrolling.get(uuid);
                if (inFlight) {
                    joined.push(inFlight);
                } else if (this.boards.has(uuid)) {
                    report.enrolled.push(uuid);
                } else {
                    pending.add(uuid);
                }
            }
        }
        if (requested === undefined || pending.size > 0) {
            this.enterListingPhase();
            try {
                const cloudDevices = await this.listCloudDevices();
                this.throwIfNotConnected();
                if (requested === undefined) {
                    for (const cloudDevice of cloudDevices) {
                        if (cloudDevice.onlineStatus !== 1) {
                            continue;
                        }
                        joined.push(this.enrollDevice(cloudDevice));
                    }
                } else {
                    const byUuid = new Map(cloudDevices.map((row) => [row.uuid, row]));
                    for (const uuid of pending) {
                        const cloudDevice = byUuid.get(uuid);
                        if (!cloudDevice) {
                            report.skipped.push({ uuid, reason: 'unknown' });
                            continue;
                        }
                        if (cloudDevice.onlineStatus !== 1) {
                            report.skipped.push({ uuid, reason: 'offline' });
                            continue;
                        }
                        joined.push(this.enrollDevice(cloudDevice));
                    }
                }
            } finally {
                this.releaseListingPhase();
            }
        }
        await this.applyEnrollOutcomes(joined, report);
        this.throwIfNotConnected();
        return report;
    }

    /**
     * Looks up an enrolled endpoint by inventory row id.
     */
    endpoint(id: string): Endpoint {
        const board = this.boards.get(uuidFromInventoryId(id));
        if (!board) {
            throw new MerossError(`Unknown endpoint: ${id}`, 'ENDPOINT_NOT_FOUND');
        }
        return board.endpoint(id);
    }

    /**
     * Stops a device's board and drops its inventory rows. Awaits an in-flight
     * enroll for that uuid first so a poller cannot start afterward. An Endpoint
     * already returned for it rejects commands until that uuid is enrolled again.
     * Safe when the session is not connected.
     */
    async unenroll(uuid: string): Promise<void> {
        await this.listingBarrier;
        await this.enrolling.get(uuid);
        this.router?.forget(uuid);
        const board = this.boards.get(uuid);
        if (board) {
            board.stop();
            this.boards.delete(uuid);
        }
        this.refreshInventory();
    }

    /**
     * Closes transports without discarding the stored token. Sets
     * {@link closing}, stops pollers, waits for in-flight enrolls (which skip
     * materialize when closing), then tears down transports. Overlapping callers
     * share one teardown.
     */
    async disconnect(): Promise<void> {
        if (this.disconnectPromise) {
            return this.disconnectPromise;
        }
        this.closing = true;
        this.clearEnrollment();
        this.disconnectPromise = this.performDisconnect();
        try {
            await this.disconnectPromise;
        } finally {
            this.disconnectPromise = undefined;
            this.closing = false;
        }
    }

    /**
     * Closes transports, invalidates the cloud token, and clears local
     * credentials. Unlike {@link disconnect}, the stored token must not be
     * persisted or passed to {@link Session.restore} afterward. Idempotent when
     * already logged out.
     */
    async logout(): Promise<void> {
        if (!this.credentialsValid) {
            return;
        }
        await this.disconnect();
        await this.cloud.logout();
        this.credentialsValid = false;
    }

    /**
     * {@link disconnect} rejects new work while {@link closing} is set. After
     * it finishes, {@link closing} is clear and {@link router} is gone.
     */
    private throwIfNotConnected(): void {
        if (this.closing || !this.router) {
            throw new MerossError('Session is not connected', 'NOT_CONNECTED');
        }
    }

    /**
     * Transports only exist between {@link connect} and {@link disconnect}, and
     * device timers can outlive a teardown by one tick, so reads go through here
     * to fail as NOT_CONNECTED instead of a TypeError.
     */
    private get connectedRouter(): TransportRouter {
        if (!this.router) {
            throw new MerossError('Session is not connected', 'NOT_CONNECTED');
        }
        return this.router;
    }

    private createRouter(): TransportRouter {
        const dispatcher = new ProtocolDispatcher({
            onPush: (message) => this.findBoardForMessage(message)?.applyUpdate(message),
            onInbound: (message, originUuid) => {
                this.findBoardForMessage(message, originUuid)?.observeInbound(message, originUuid);
            }
        });
        const mqtt = new MqttTransport({
            userId: this.token.userId,
            key: this.token.key,
            mqttDomain: this.token.mqttDomain,
            dispatcher,
            connect: this.mqttConnect,
            logger: this.logger,
            logLevel: this.logLevel,
            onConnectionChange: (connected) => {
                if (!connected) {
                    for (const board of this.boards.values()) {
                        board.clearMqttActive();
                    }
                }
                this.emit('connection', connected);
            },
            onRateLimit: (uuid, dropped) => this.emit('ratelimit', uuid, dropped)
        });
        const lan = new LanHttpTransport({
            key: this.token.key,
            from: mqtt.clientResponseTopic,
            dispatcher,
            fetch: this.lanFetch,
            logger: this.logger,
            logLevel: this.logLevel
        });
        return new TransportRouter({ mqtt, lan });
    }

    /**
     * Board for a non-empty `originUuid` when set, otherwise for the uuid
     * in the message header/`from`.
     */
    private findBoardForMessage(
        message: MerossMessage,
        originUuid?: string
    ): Board | undefined {
        const uuid = originUuid || uuidFromHeader(message.header);
        return uuid ? this.boards.get(uuid) : undefined;
    }

    private async disconnectRouter(): Promise<void> {
        const router = this.router;
        this.router = undefined;
        this.connecting = undefined;
        await router?.disconnect();
    }

    /** Waits for in-flight reads before tearing down their transports. */
    private async performDisconnect(): Promise<void> {
        await Promise.allSettled(this.enrolling.values());
        await this.disconnectRouter();
    }

    /** Stops boards and clears membership without touching transports. */
    private clearEnrollment(): void {
        for (const [uuid, board] of this.boards) {
            this.router?.forget(uuid);
            board.stop();
        }
        this.boards.clear();
        this.inventory.replace([]);
    }

    /**
     * Joins the phase {@link listingBarrier} covers. Called before `devList`
     * so {@link unenroll} cannot finish before {@link enrollDevice} stores passes.
     */
    private enterListingPhase(): void {
        if (this.listingBarrier === undefined) {
            this.listingBarrier = new Promise<void>((resolve) => {
                this.releaseListingBarrier = resolve;
            });
        }
        this.listingPending += 1;
    }

    /**
     * Leaves the list-or-register phase. The last caller opens
     * {@link listingBarrier}. Runs after passes are stored, and also when
     * listing fails, so {@link unenroll} cannot wait forever.
     */
    private releaseListingPhase(): void {
        this.listingPending -= 1;
        if (this.listingPending > 0) {
            return;
        }
        this.releaseListingBarrier?.();
        this.releaseListingBarrier = undefined;
        this.listingBarrier = undefined;
    }

    /**
     * Shared `devList` so concurrent {@link enroll} calls do not list twice.
     */
    private listCloudDevices(): Promise<CloudDevice[]> {
        this.listing ??= this.cloud.listDevices().finally(() => {
            this.listing = undefined;
        });
        return this.listing;
    }

    private async applyEnrollOutcomes(
        joined: readonly Promise<DeviceEnrollOutcome>[],
        report: MutableEnrollReport
    ): Promise<void> {
        for (const outcome of await Promise.all(joined)) {
            if (outcome.status === 'enrolled') {
                if (!report.enrolled.includes(outcome.uuid)) {
                    report.enrolled.push(outcome.uuid);
                }
            } else if (outcome.status === 'failed') {
                report.failed.push({ uuid: outcome.uuid, error: outcome.error });
            }
        }
    }

    /**
     * One pass per uuid. A repeat caller joins the in-flight promise, and an
     * already-enrolled uuid must not contact the device again.
     */
    private enrollDevice(cloudDevice: CloudDevice): Promise<DeviceEnrollOutcome> {
        const uuid = cloudDevice.uuid;
        const inFlight = this.enrolling.get(uuid);
        if (inFlight) {
            return inFlight;
        }
        if (this.boards.has(uuid)) {
            return Promise.resolve({ status: 'enrolled', uuid });
        }
        const pass = this.performEnrollPass(cloudDevice).finally(() => {
            this.enrolling.delete(uuid);
        });
        this.enrolling.set(uuid, pass);
        return pass;
    }

    /**
     * One Ability / System.All pass under the global slot limiter. Skips
     * materialize when {@link closing} so disconnect cannot leave a poller.
     */
    private async performEnrollPass(
        cloudDevice: CloudDevice
    ): Promise<DeviceEnrollOutcome> {
        return this.withEnrollSlot(async () => {
            const uuid = cloudDevice.uuid;
            if (this.closing) {
                return { status: 'closed', uuid };
            }
            try {
                if (this.boards.has(uuid)) {
                    return { status: 'enrolled', uuid };
                }
                const board = new Board(uuid, {
                    garageStatePolling: this.garageStatePolling,
                    request: (options) => this.connectedRouter.request({
                        uuid,
                        ...options
                    }),
                    requestGets: (options) => this.connectedRouter.requestGets({
                        uuid,
                        ...options
                    }),
                    isCloudPath: (ip) => this.connectedRouter.isCloudPath(uuid, ip),
                    isHttpDown: () => this.connectedRouter.isHttpDown(uuid),
                    userKey: () => this.token.key,
                    listSubDevices: (hubUuid) => this.cloud.listSubDevices(hubUuid),
                    warn: (error, warnUuid) => this.emitWarning(error, warnUuid),
                    nextStartDelayMs: () => {
                        const delay = (this.startedDevices * POLL_START_STAGGER_MS)
                            % DEFAULT_POLL_INTERVAL_MS;
                        this.startedDevices += 1;
                        return delay;
                    },
                    isClosing: () => this.closing
                });
                const enrolled = await board.enroll(cloudDevice);
                if (!enrolled || this.closing) {
                    return { status: 'closed', uuid };
                }
                // Membership before start so a start failure still leaves the board.
                this.boards.set(uuid, board);
                this.refreshInventory();
                board.start();
                return { status: 'enrolled', uuid };
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (!this.closing) {
                    this.emitWarning(err, uuid);
                }
                return { status: 'failed', uuid, error: err };
            }
        });
    }

    /**
     * Caps concurrent Ability / System.All passes at {@link ENROLL_CONCURRENCY}
     * across overlapping {@link enroll} callers. Re-checks after each wake so a
     * new caller cannot steal the slot a waiter was promised.
     */
    private async withEnrollSlot<T>(run: () => Promise<T>): Promise<T> {
        while (this.activeEnrolls >= ENROLL_CONCURRENCY) {
            await new Promise<void>((resolve) => {
                this.enrollWaiters.push(resolve);
            });
        }
        this.activeEnrolls += 1;
        try {
            return await run();
        } finally {
            this.activeEnrolls -= 1;
            const next = this.enrollWaiters.shift();
            next?.();
        }
    }

    private emitWarning(error: unknown, uuid?: string): void {
        this.emit(
            'warning',
            error instanceof Error ? error : new Error(String(error)),
            uuid
        );
    }

    private refreshInventory(): void {
        this.inventory.replace(
            [...this.boards.values()].flatMap((board) => board.inventoryRows())
        );
    }
}
