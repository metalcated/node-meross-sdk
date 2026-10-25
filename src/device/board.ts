import type { CloudDevice, CloudSubDevice } from '../cloud';
import { Endpoint } from './endpoint';
import { MerossError } from '../errors';
import type { InventoryRow } from '../inventory';
import {
    buildPollJobs,
    DEFAULT_POLL_INTERVAL_MS,
    SENSOR_FAST_CLOUD_PERIOD_MS,
    SYSTEM_ALL_PERIOD_MS,
    type PollJob
} from '../poll';
import { GARAGE_STATE_NAMESPACE } from '../protocol/codecs/cover';
import {
    ONLINE_NAMESPACE,
    decodeOnlineStatus
} from '../protocol/codecs/online';
import {
    LanEncryptionKeys,
    macAddressFromUuid,
    supportsLanEncryption
} from '../protocol/encryption';
import { EMPTY_PAYLOAD, type MerossMessage, type MerossPayload } from '../protocol/message';
import { HUB_SUBDEVICE_LIST_NAMESPACE } from '../protocol/namespaces';
import type { DeviceRequest } from '../request';
import type { GetCommand } from '../transport/router';
import { attachEndpoint } from './attach';
import {
    ABILITY_NAMESPACE,
    SYSTEM_ALL_NAMESPACE,
    decodeAbilityGetAck,
    enrollPhysicalDevice,
    projectInventoryRows,
    type PhysicalDevice
} from './index';
import { Runtime } from './runtime';

/**
 * Transport and session hooks Board needs without owning the router or cloud
 * client. Scoped to this board's uuid by the Session that constructs it.
 */
export interface BoardDeps {
    /** Explicit host opt-in; default catalog polling remains unchanged. */
    garageStatePolling?: boolean;
    request: (options: {
        namespace: string;
        method: string;
        payload?: MerossPayload;
        priority?: 'user' | 'background';
        ip?: string | null;
        encryptionKey?: Buffer;
    }) => Promise<MerossMessage>;
    requestGets: (options: {
        gets: GetCommand[];
        maxCmdNum?: number;
        priority?: 'user' | 'background';
        ip?: string | null;
        encryptionKey?: Buffer;
        onPackedFallback?: () => void;
    }) => Promise<MerossMessage[]>;
    isCloudPath: (ip?: string | null) => boolean;
    isHttpDown: () => boolean;
    /** Account key so reauthenticate refreshes the next LAN wrap. */
    userKey: () => string;
    listSubDevices: (uuid: string) => Promise<CloudSubDevice[]>;
    warn: (error: unknown, uuid?: string) => void;
    /** Called only when a runtime is constructed. */
    nextStartDelayMs: () => number;
    isClosing: () => boolean;
}

/**
 * One physical device: enroll, endpoints, poller/availability runtime, and that
 * uuid's LAN key memo. Session keeps credentials, transports, and membership.
 */
export class Board {
    readonly uuid: string;
    private readonly deps: BoardDeps;
    private readonly lanKeys = new LanEncryptionKeys();
    private readonly endpoints = new Map<string, Endpoint>();
    private physical: PhysicalDevice | undefined;
    private runtime: Runtime | undefined;
    /** After {@link stop}, {@link request} rejects like an unenrolled device. */
    private stopped = false;

    constructor(uuid: string, deps: BoardDeps) {
        this.uuid = uuid;
        this.deps = deps;
    }

    /**
     * Ability + System.All, then attach and construct the runtime. Create-once:
     * Session never re-reads a live board. Does not start the poller — Session
     * registers the board before {@link start} so push lookup cannot miss the
     * first tick. Returns false when closing after the Ability await.
     */
    async enroll(cloudDevice: CloudDevice): Promise<boolean> {
        if (this.runtime || this.physical) {
            throw new MerossError(
                `Board already enrolled: ${this.uuid}`,
                'ALREADY_ENROLLED'
            );
        }
        const [abilityReply, allReply] = await this.deps.requestGets({
            gets: [
                { namespace: ABILITY_NAMESPACE, payload: EMPTY_PAYLOAD },
                { namespace: SYSTEM_ALL_NAMESPACE, payload: EMPTY_PAYLOAD }
            ]
        });

        const ability = decodeAbilityGetAck(abilityReply.payload);
        let subDevices: CloudSubDevice[] | undefined;
        if (HUB_SUBDEVICE_LIST_NAMESPACE in ability) {
            try {
                subDevices = await this.deps.listSubDevices(cloudDevice.uuid);
            } catch (error) {
                // Digest children still enroll; only the cloud name overlay is lost.
                this.deps.warn(error, cloudDevice.uuid);
            }
        }

        if (this.deps.isClosing()) {
            return false;
        }

        this.physical = enrollPhysicalDevice({
            abilityPayload: abilityReply.payload,
            allPayload: allReply.payload,
            cloud: cloudDevice,
            subDevices
        });
        this.materialize();
        return true;
    }

    /**
     * Session calls after `boards.set` so a start failure still counts as enrolled.
     */
    start(): void {
        this.runtime?.start();
    }

    /**
     * Inventory ids for this uuid only. Session flatMaps every board.
     */
    inventoryRows(): InventoryRow[] {
        return this.physical ? projectInventoryRows(this.physical) : [];
    }

    endpoint(id: string): Endpoint {
        const endpoint = this.endpoints.get(id);
        if (!endpoint) {
            throw new MerossError(`Unknown endpoint: ${id}`, 'ENDPOINT_NOT_FOUND');
        }
        return endpoint;
    }

    /**
     * MQTT (`originUuid` omitted) records MQTT activity and liveness, except
     * System.Online that is not PUSH with status 1. LAN (POST uuid) observes
     * liveness without recording MQTT activity. Payload state is
     * {@link applyUpdate}.
     */
    observeInbound(message: MerossMessage, originUuid?: string): void {
        if (!this.runtime) {
            return;
        }
        if (
            originUuid === undefined
            && message.header.namespace === ONLINE_NAMESPACE
            && (
                message.header.method !== 'PUSH'
                || decodeOnlineStatus(message.payload) !== 1
            )
        ) {
            return;
        }
        if (originUuid === undefined) {
            this.runtime.markMqttActive();
        }
        this.runtime.observeInbound(message);
    }

    /**
     * Availability payload and trait state for an accepted PUSH or unpacked
     * GETACK. Observation of the same frame is {@link observeInbound}.
     */
    applyUpdate(message: MerossMessage): void {
        this.runtime?.applyUpdate(message);
    }

    clearMqttActive(): void {
        this.runtime?.clearMqttActive();
    }

    /**
     * Stops the runtime and drops the LAN key. Session still calls
     * `router.forget` because it owns the router.
     */
    stop(): void {
        this.stopped = true;
        this.lanKeys.remove(this.uuid);
        const runtime = this.runtime;
        if (!runtime) {
            return;
        }
        runtime.stop();
        this.endpoints.clear();
        this.runtime = undefined;
    }

    private materialize(): void {
        const physical = this.physical!;
        const request = this.deviceRequest(physical);
        const namespaces = new Set(Object.keys(physical.ability));
        const attached: Endpoint[] = [];
        for (const graphEndpoint of physical.endpoints) {
            const endpoint = attachEndpoint(graphEndpoint, request, physical, namespaces);
            this.endpoints.set(graphEndpoint.id, endpoint);
            attached.push(endpoint);
        }

        const startDelayMs = this.deps.nextStartDelayMs();
        this.runtime = new Runtime({
            uuid: this.uuid,
            initialOnline: physical.online,
            endpoints: attached,
            request: (namespace, method, payload) => request({
                namespace,
                method,
                payload: payload ?? EMPTY_PAYLOAD,
                priority: 'background'
            }),
            onInnerIp: (innerIp) => {
                physical.innerIp = innerIp;
            },
            isCloudPath: () => this.deps.isCloudPath(physical.innerIp),
            httpDown: () => this.deps.isHttpDown(),
            maxCmdNum: () => physical.maxCmdNum,
            requestGets: (gets, maxCmdNum, onPackedFallback) => this.deps.requestGets({
                gets,
                maxCmdNum,
                priority: 'background',
                ...this.lanBind(physical),
                onPackedFallback
            }),
            jobs: boardPollJobs(physical, this.deps.garageStatePolling ?? false),
            startDelayMs
        });
    }

    private lanBind(physical: PhysicalDevice) {
        if (!supportsLanEncryption(physical.ability)) {
            this.lanKeys.remove(physical.uuid);
            return { ip: physical.innerIp };
        }
        const mac = physical.macAddress ?? macAddressFromUuid(physical.uuid);
        return {
            ip: physical.innerIp,
            encryptionKey: this.lanKeys.derive(
                physical.uuid,
                this.deps.userKey(),
                mac
            )
        };
    }

    private deviceRequest(physical: PhysicalDevice): DeviceRequest {
        return (options) => {
            if (this.stopped || !this.runtime) {
                throw new MerossError(
                    `Unknown endpoint: ${physical.uuid}`,
                    'ENDPOINT_NOT_FOUND'
                );
            }
            return this.deps.request({
                ...this.lanBind(physical),
                ...options
            }).finally(() => {
                this.runtime?.refreshProtocol();
            });
        };
    }
}

/**
 * Measured MSG100 hardware accepts single-channel Garage.State and All GETs.
 * Its advertised optional namespaces/all-channel query are not needed for
 * state tracking. Poll explicitly even while MQTT traffic is present: some
 * firmware acknowledges movement without sending the final state PUSH.
 * Keep the same exact model scope as the existing Control.Multiple guard.
 */
function boardPollJobs(physical: PhysicalDevice, garageStatePolling: boolean): PollJob[] {
    if (
        !garageStatePolling
        || (
            physical.model.toLowerCase() !== 'msg100'
            && physical.system.hardware.type.toLowerCase() !== 'msg100'
        )
    ) {
        return buildPollJobs(physical.ability, physical.endpoints, physical.digestNamespaces);
    }
    const jobs: PollJob[] = [{
        namespace: SYSTEM_ALL_NAMESPACE,
        strategy: 'smart',
        periodMs: DEFAULT_POLL_INTERVAL_MS,
        periodCloudMs: SYSTEM_ALL_PERIOD_MS,
        payload: EMPTY_PAYLOAD
    }];
    if (GARAGE_STATE_NAMESPACE in physical.ability) {
        jobs.push({
            namespace: GARAGE_STATE_NAMESPACE,
            strategy: 'smart',
            periodMs: DEFAULT_POLL_INTERVAL_MS,
            periodCloudMs: SENSOR_FAST_CLOUD_PERIOD_MS,
            payload: { state: { channel: 0 } }
        });
    }
    return jobs;
}
