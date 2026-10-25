import type { CoverTraitBind } from '../device/bindings';
import { ProtocolError } from '../errors';
import {
    GARAGE_CONFIG_NAMESPACE,
    GARAGE_MULTIPLE_CONFIG_NAMESPACE,
    GARAGE_STATE_NAMESPACE,
    decodeGarageConfigGetAck,
    decodeGarageGetAck,
    decodeGarageMultipleConfigGetAck,
    decodeGaragePush,
    encodeGarageGet,
    encodeGarageConfigSet,
    encodeGarageMultipleConfigSet,
    encodeGarageSet,
    type GarageDoorConfig,
    type GarageMultipleConfigEntry
} from '../protocol/codecs/cover';
import type { MerossMessage } from '../protocol/message';
import { CoverTraitBase, type CoverValues } from './cover-core';

/**
 * GarageDoor.State. Firmware has no stop or position.
 */
export class CoverGarageTrait extends CoverTraitBase {
    readonly kind = 'garage' as const;

    private lastGarageConfig: GarageDoorConfig | undefined;
    private lastMultipleConfig: GarageMultipleConfigEntry | undefined;
    private polling: Promise<CoverValues> | undefined;

    /** @internal */
    constructor(bind: CoverTraitBind) {
        super(bind);
    }

    async open(): Promise<{ open: boolean }> {
        return { open: await this.setGarage(true) };
    }

    async close(): Promise<{ open: boolean }> {
        return { open: await this.setGarage(false) };
    }

    /**
     * Read this door's reported contact state, including when firmware omits
     * the final PUSH after a command. Overlapping callers share one GET.
     * Never sends a command or requests the unverified all-channel sentinel.
     */
    poll(): Promise<CoverValues> {
        if (this.polling) {
            return this.polling;
        }
        const pending = Promise.resolve().then(() => this.request({
            namespace: GARAGE_STATE_NAMESPACE,
            method: 'GET',
            payload: encodeGarageGet({ channel: this.channel })
        })).then((reply) => {
            const raw = reply.payload.state;
            const rows: unknown[] = Array.isArray(raw) ? raw : [raw];
            const matchingRows = rows.filter((row) => typeof row === 'object'
                && row !== null
                && (row as Record<string, unknown>).channel === this.channel);
            const matching = matchingRows[0] as Record<string, unknown> | undefined;
            if (
                reply.header.namespace !== GARAGE_STATE_NAMESPACE
                || reply.header.method !== 'GETACK'
                || matchingRows.length !== 1
                || !matching
                || (matching.open !== 0 && matching.open !== 1)
            ) {
                throw new ProtocolError('GarageDoor.State GETACK must report the requested channel and open state');
            }
            this.handlePush(reply);
            return this.values();
        });
        this.polling = pending;
        const clear = (): void => {
            if (this.polling === pending) {
                this.polling = undefined;
            }
        };
        // Observe both outcomes without creating an unhandled rejected
        // finally-Promise. The caller still receives the original failure.
        void pending.then(clear, clear);
        return pending;
    }

    /**
     * Undefined until poller GETACK or PUSH fills it.
     * Prefers MultipleConfig when both namespaces are advertised.
     */
    getConfig(): GarageMultipleConfigEntry | GarageDoorConfig | undefined {
        if (this.has(GARAGE_MULTIPLE_CONFIG_NAMESPACE)) {
            return this.lastMultipleConfig && { ...this.lastMultipleConfig };
        }
        if (this.has(GARAGE_CONFIG_NAMESPACE)) {
            return this.lastGarageConfig && { ...this.lastGarageConfig };
        }
        return undefined;
    }

    /**
     * Uses MultipleConfig (MSG200) when advertised, else Config (MSG100).
     */
    async setConfig(
        config: Partial<GarageDoorConfig> | GarageMultipleConfigEntry
    ): Promise<void> {
        if (this.has(GARAGE_MULTIPLE_CONFIG_NAMESPACE)) {
            const entry = {
                ...(config as GarageMultipleConfigEntry),
                channel: this.channel
            };
            await this.request({
                namespace: GARAGE_MULTIPLE_CONFIG_NAMESPACE,
                method: 'SET',
                payload: encodeGarageMultipleConfigSet(entry)
            });
            this.lastMultipleConfig = { ...this.lastMultipleConfig, ...entry };
            return;
        }
        this.requireNamespace(GARAGE_CONFIG_NAMESPACE);
        const patch = config as Partial<GarageDoorConfig>;
        await this.request({
            namespace: GARAGE_CONFIG_NAMESPACE,
            method: 'SET',
            payload: encodeGarageConfigSet(patch)
        });
        if (this.lastGarageConfig !== undefined) {
            this.lastGarageConfig = { ...this.lastGarageConfig, ...patch };
        }
    }

    /**
     * PUSH/GETACK from Runtime. Hosts subscribe to Endpoint `change`.
     *
     * @internal
     * @package
     */
    handlePush(message: MerossMessage): void {
        const ns = message.header.namespace;
        if (ns === GARAGE_STATE_NAMESPACE) {
            for (const entry of decodeGaragePush(message.payload)) {
                if (entry.channel === this.channel) {
                    this.applyChange({ open: entry.open });
                    if (this.last.moving === true) {
                        this.applyMoving(false);
                    }
                }
            }
            return;
        }
        if (ns === GARAGE_MULTIPLE_CONFIG_NAMESPACE && this.has(ns)) {
            const entry = decodeGarageMultipleConfigGetAck(message.payload)
                .find((e) => e.channel === this.channel);
            if (entry) {
                this.lastMultipleConfig = entry;
            }
            return;
        }
        if (ns === GARAGE_CONFIG_NAMESPACE && this.has(ns)) {
            this.lastGarageConfig = decodeGarageConfigGetAck(message.payload);
        }
    }

    /**
     * SETACK `open` is the current state, not the command. `execute` 1 with
     * a different `open` means the door is still travelling.
     */
    private async setGarage(open: boolean): Promise<boolean> {
        const reply = await this.request({
            namespace: GARAGE_STATE_NAMESPACE,
            method: 'SET',
            payload: encodeGarageSet({ channel: this.channel, open })
        });
        for (const entry of decodeGarageGetAck(reply.payload)) {
            if (entry.channel !== this.channel) {
                continue;
            }
            this.applyChange({ open: entry.open });
            const moving = entry.execute === true && entry.open !== open;
            if (moving || this.last.moving === true) {
                this.applyMoving(moving);
            }
        }
        return this.last.open ?? open;
    }
}
