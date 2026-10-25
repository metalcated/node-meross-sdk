import { PackedFallbackError } from '../errors';
import { canPackInMultiple } from '../protocol/codecs/multiple';
import { EMPTY_PAYLOAD, type MerossMessage, type MerossPayload } from '../protocol/message';
import type { GetCommand } from '../transport/router';
import {
    estimateResponseSize,
    getDeviceResponseSizeMax,
    POLL_RESPONSE_HEADER_SIZE,
    POLL_RESPONSE_SIZE_MIN,
    SYSTEM_ALL_PERIOD_MS
} from './jobs';
import { SYSTEM_ALL_NAMESPACE } from '../protocol/codecs/system-all';
import type { PollStrategy } from './spec';

export type { PollStrategy };

/** One shared tick so traits do not each run their own timer. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Per-device offset Session multiplies by enrollment order. Without it every
 * device would fire its first tick in the same event loop turn and then stay in
 * lockstep, bunching LAN POSTs and cloud publishes on one instant.
 */
export const POLL_START_STAGGER_MS = 250;

/**
 * Slack before a still-pending request is treated as overdue rather than
 * in flight. Shorter than {@link DEFAULT_POLL_INTERVAL_MS} so a hung GET
 * does not block the next tick forever.
 */
const RESPONSE_SLACK_MS = 2_000;

/**
 * One namespace GET for a physical device. Deduplicated by `namespace` so a
 * multi-gang strip does not issue the same Electricity GET four times.
 */
export interface PollJob {
    namespace: string;
    strategy: PollStrategy;
    periodMs: number;
    periodCloudMs: number;
    payload?: MerossPayload;
    /**
     * Estimated GETACK bytes used when packing Control.Multiple. When omitted,
     * Poller estimates from the namespace table (ConsumptionX starts at
     * 30 days).
     */
    responseSize?: number;
    /** ConsumptionX GETACK day count replaces the 30-day packing reserve. */
    calibrate?: (payload: MerossPayload) => number | undefined;
    /** FilterMaintenance (and other PUSHQ ns) must not GET. */
    method?: 'GET' | 'PUSH';
}

export interface PollerOptions {
    isOnline: () => boolean;
    /**
     * True when the next batch will go over cloud MQTT (no LAN IP, or HTTP
     * marked down), which limits the cycle to a single publish rather than one
     * request per due job.
     */
    isCloudPath: () => boolean;
    /**
     * Extra System.All while MQTT is live, only after HTTP had a host and then
     * missed. {@link isCloudPath} is also true with no LAN IP, which must not
     * probe.
     */
    httpDown?: () => boolean;
    maxCmdNum: () => number;
    requestGets: (gets: GetCommand[], maxCmdNum: number) => Promise<MerossMessage[]>;
    /**
     * GETACK is a pending reply, not PUSH, so the dispatcher will not call
     * onPush. Session still applies the payload on this device.
     */
    onAck: (message: MerossMessage) => void;
    jobs?: readonly PollJob[];
    intervalMs?: number;
    /** Delay before the first tick; see {@link POLL_START_STAGGER_MS}. */
    startDelayMs?: number;
    now?: () => number;
}

interface JobState {
    namespace: string;
    strategy: PollStrategy;
    periodMs: number;
    periodCloudMs: number;
    payload: MerossPayload;
    method: 'GET' | 'PUSH';
    responseSize: number;
    calibrate?: (payload: MerossPayload) => number | undefined;
    /** `null` means cold start / re-online — must poll even under MQTT skip. */
    nextMs: number | null;
    /** `null` until the first request, so epoch 0 cannot read as "long ago". */
    lastRequestMs: number | null;
}

/**
 * Infinity for a job that has never run, so it sorts ahead of every job that
 * has regardless of where the clock started.
 */
function staleness(job: JobState, epoch: number): number {
    return job.lastRequestMs === null ? Number.POSITIVE_INFINITY : epoch - job.lastRequestMs;
}

/** Longest-waiting first, so no namespace is starved by a busier one. */
function byStalest(jobs: readonly JobState[], epoch: number): JobState[] {
    return [...jobs].sort((a, b) => staleness(b, epoch) - staleness(a, epoch));
}

/**
 * HTTP always sends. Cloud MQTT spends one publish per cycle unless this
 * namespace is past its cloud period. A job that has never run is not treated
 * as "recent", so a cold start still goes out.
 */
function allowSmartpoll(
    job: JobState,
    epoch: number,
    cloudPath: boolean,
    queuedCloud: number
): boolean {
    if (!cloudPath || queuedCloud < 1) {
        return true;
    }
    if (job.lastRequestMs === null) {
        return true;
    }
    return epoch - job.lastRequestMs >= job.periodCloudMs;
}

/**
 * PUSH-query and namespaces that cannot share Control.Multiple must go out
 * alone so they are not packed with (or truncated by) sibling GETs.
 */
function isUnscoped(job: JobState): boolean {
    return job.method === 'PUSH' || !canPackInMultiple(job.namespace);
}

/**
 * One loop per physical device: MQTT skip, cloud rate limit, and leftover
 * Multiple batch room for jobs that can wait.
 */
export class Poller {
    private readonly isOnline: () => boolean;
    private readonly isCloudPath: () => boolean;
    private readonly httpDown: () => boolean;
    private readonly maxCmdNum: () => number;
    private readonly requestGets: PollerOptions['requestGets'];
    private readonly onAck: (message: MerossMessage) => void;
    private readonly intervalMs: number;
    private readonly startDelayMs: number;
    private readonly now: () => number;

    private readonly jobs = new Map<string, JobState>();
    /** Broker has delivered traffic for this uuid; default/All can ride PUSH. */
    private mqttActive = false;
    /**
     * Last poll send / receive. `null` rather than `0` because epoch 0 is a
     * valid test clock.
     */
    private lastRequestMs: number | null = null;
    private lastResponseMs: number | null = null;
    private offlineDelayMs: number;
    /**
     * Tightened packed-GETACK budget after a truncated Multiple, so the next
     * cycle packs less.
     */
    private shrunkResponseMax: number | undefined;
    /** Changes whenever an in-flight packed request reports truncation. */
    private responseBudgetRevision = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running = false;

    /**
     * Packing state for the tick in flight. Reset by {@link resetTickState}.
     * `perform` clears `this.timer` before awaiting, and `setOnline` only
     * reschedules when a timer is pending, so two ticks cannot overlap.
     */
    private tickEpoch = 0;
    private tickCloudPath = false;
    private tickMaxCmdNum = 0;
    private tickBatchSize = 1;
    private tickSizeMax = 0;
    private tickMqttActive = false;
    private tickQueuedCloud = 0;
    private readonly tickBuffer: JobState[] = [];
    private tickBufferSize = POLL_RESPONSE_HEADER_SIZE;
    private readonly tickLazy: JobState[] = [];

    constructor(options: PollerOptions) {
        this.isOnline = options.isOnline;
        this.isCloudPath = options.isCloudPath;
        this.httpDown = options.httpDown ?? (() => false);
        this.maxCmdNum = options.maxCmdNum;
        this.requestGets = options.requestGets;
        this.onAck = options.onAck;
        this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.startDelayMs = options.startDelayMs ?? 0;
        this.now = options.now ?? Date.now;
        this.offlineDelayMs = this.intervalMs;
        // First entry wins per namespace so a multi-gang strip does not GET the
        // same Electricity (or other) namespace once per channel.
        for (const job of options.jobs ?? []) {
            if (this.jobs.has(job.namespace)) {
                continue;
            }
            const payload = job.payload ?? EMPTY_PAYLOAD;
            this.jobs.set(job.namespace, {
                namespace: job.namespace,
                strategy: job.strategy,
                periodMs: job.periodMs,
                periodCloudMs: job.periodCloudMs,
                payload,
                method: job.method ?? 'GET',
                responseSize: job.responseSize ?? estimateResponseSize(job.namespace, payload),
                calibrate: job.calibrate,
                nextMs: null,
                lastRequestMs: null
            });
        }
    }

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.schedule(this.startDelayMs);
    }

    stop(): void {
        this.running = false;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * Any MQTT traffic from this device, held until broker drop or offline.
     * Default/All then ride PUSH instead of GET.
     */
    markMqttActive(): void {
        this.mqttActive = true;
        this.lastResponseMs = this.now();
    }

    /**
     * Broker drop: stop treating PUSH as a substitute for GET without implying
     * the device is unreachable over HTTP.
     */
    clearMqttActive(): void {
        this.mqttActive = false;
    }

    /**
     * Online: cold-start so MQTT skip does not leave digest state stale, and
     * cancel the pending timer so an MQTT-while-offline PUSH does not wait
     * out the offline backoff.
     * Offline: drop MQTT-active so the next online cycle re-probes.
     */
    setOnline(online: boolean): void {
        if (online) {
            this.offlineDelayMs = this.intervalMs;
            for (const job of this.jobs.values()) {
                job.nextMs = null;
            }
            if (this.running && this.timer !== undefined) {
                this.schedule(0);
            }
            return;
        }
        this.mqttActive = false;
    }

    /**
     * Midpoint of the current budget and {@link POLL_RESPONSE_SIZE_MIN} so
     * the next cycle packs less after a truncated Multiple.
     */
    shrinkResponseBudget(): void {
        const current = this.getResponseSizeMax();
        this.shrunkResponseMax = Math.floor((current + POLL_RESPONSE_SIZE_MIN) / 2);
        this.responseBudgetRevision += 1;
    }

    private resetResponseBudget(): void {
        this.shrunkResponseMax = undefined;
    }

    private getResponseSizeMax(): number {
        const advertised = getDeviceResponseSizeMax(this.maxCmdNum());
        if (this.shrunkResponseMax === undefined) {
            return advertised;
        }
        return Math.max(POLL_RESPONSE_SIZE_MIN, Math.min(this.shrunkResponseMax, advertised));
    }

    private updateResponseSizeFromReply(message: MerossMessage): void {
        const job = this.jobs.get(message.header.namespace);
        const size = job?.calibrate?.(message.payload);
        if (job && size !== undefined) {
            job.responseSize = size;
        }
    }

    private schedule(delayMs: number): void {
        if (!this.running) {
            return;
        }
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        // Do not unref: Homey (and similar hosts) can drop unref'd timers while
        // the app process stays alive for other reasons, which stops polling.
        this.timer = setTimeout(() => {
            void this.perform();
        }, delayMs);
    }

    private async perform(): Promise<void> {
        if (!this.running) {
            return;
        }
        // Clear the timer before the tick so a PUSH that onlines mid-poll
        // cannot start a second loop.
        this.timer = undefined;
        try {
            const epoch = this.now();
            if (this.isOnline() && this.isStrictlyOnline(epoch)) {
                await this.runOnlineTick();
            } else if (await this.requestSystemAllProbe()) {
                // Digest is inside that All GETACK; remaining jobs walk with All skipped.
                if (this.isOnline()) {
                    await this.runOnlineTick(true);
                }
            } else if (!this.isOnline()) {
                this.offlineDelayMs = Math.min(
                    this.offlineDelayMs + this.intervalMs,
                    SYSTEM_ALL_PERIOD_MS
                );
            }
        } finally {
            this.schedule(this.isOnline() ? this.intervalMs : this.offlineDelayMs);
        }
    }

    /**
     * Skip the NS_ALL probe when the last poll was answered, or is still
     * within the interval minus slack. Never-sent (`null`) walks All as due
     * rather than probing and then skipping All. Frozen clocks stamp send
     * and receive with the same `epoch`, so equality means answered.
     */
    private isStrictlyOnline(epoch: number): boolean {
        if (this.lastRequestMs === null) {
            return true;
        }
        if (this.lastResponseMs !== null && this.lastResponseMs >= this.lastRequestMs) {
            return true;
        }
        return epoch - this.lastRequestMs < this.intervalMs - RESPONSE_SLACK_MS;
    }

    private async requestSystemAllProbe(): Promise<boolean> {
        const epoch = this.now();
        this.lastRequestMs = epoch;
        try {
            const replies = await this.requestGets(
                [{ namespace: SYSTEM_ALL_NAMESPACE, payload: EMPTY_PAYLOAD }],
                1
            );
            this.lastResponseMs = epoch;
            this.markSystemAllRequested(epoch);
            for (const reply of replies) {
                this.onAck(reply);
            }
            return true;
        } catch {
            return false;
        }
    }

    /** Probe already sent System.All; the following walk must not GET it again. */
    private markSystemAllRequested(epoch: number): void {
        const job = this.jobs.get(SYSTEM_ALL_NAMESPACE);
        if (job) {
            job.lastRequestMs = epoch;
            job.nextMs = epoch + job.periodMs;
        }
    }

    /** Reset packing scratch so a previous tick cannot leak into this one. */
    private resetTickState(): void {
        this.tickEpoch = this.now();
        this.tickCloudPath = this.isCloudPath();
        this.tickMaxCmdNum = this.maxCmdNum();
        this.tickBatchSize = this.tickMaxCmdNum >= 2 ? this.tickMaxCmdNum : 1;
        this.tickSizeMax = this.getResponseSizeMax();
        this.tickMqttActive = this.mqttActive;
        this.tickQueuedCloud = 0;
        this.tickBuffer.length = 0;
        this.tickBufferSize = POLL_RESPONSE_HEADER_SIZE;
        this.tickLazy.length = 0;
    }

    private markJobsRequested(jobs: readonly JobState[]): void {
        this.lastRequestMs = this.tickEpoch;
        for (const job of jobs) {
            job.lastRequestMs = this.tickEpoch;
            job.nextMs = this.tickEpoch + job.periodMs;
        }
    }

    private clearPackBuffer(): void {
        this.tickBuffer.length = 0;
        this.tickBufferSize = POLL_RESPONSE_HEADER_SIZE;
    }

    /**
     * Stamp last-request / next before send so a failed or rate-limited batch
     * still waits for its period.
     */
    private async sendJobs(sending: JobState[], pack: boolean): Promise<void> {
        this.markJobsRequested(sending);
        const responseBudgetRevision = this.responseBudgetRevision;
        if (this.tickCloudPath) {
            this.tickQueuedCloud += 1;
        }
        try {
            const replies = await this.requestGets(
                sending.map((job) => ({
                    namespace: job.namespace,
                    payload: job.payload,
                    method: job.method
                })),
                pack ? this.tickMaxCmdNum : 1
            );
            this.lastResponseMs = this.tickEpoch;
            if (
                pack
                && replies.length === sending.length
                && this.responseBudgetRevision === responseBudgetRevision
            ) {
                this.resetResponseBudget();
            }
            for (const reply of replies) {
                this.updateResponseSizeFromReply(reply);
                this.onAck(reply);
            }
        } catch (error) {
            // Partial fallback GETACKs still apply. The batch rejected, so
            // lastResponseMs stays unset and the next tick can probe.
            if (error instanceof PackedFallbackError) {
                for (const reply of error.replies) {
                    this.updateResponseSizeFromReply(reply);
                    this.onAck(reply);
                }
            }
            // A `once` job has no period to fall back on, so leave it cold
            // rather than let one failed batch retire it for good.
            for (const job of sending) {
                if (job.strategy === 'once') {
                    job.nextMs = null;
                }
            }
        }
    }

    /**
     * Fill leftover Multiple slots with jobs that can wait — the publish is
     * already being spent — then send.
     */
    private async flushPackBuffer(): Promise<void> {
        if (this.tickMaxCmdNum >= 2 && this.tickBuffer.length > 0) {
            for (const job of byStalest(this.tickLazy, this.tickEpoch)) {
                if (this.tickBuffer.length >= this.tickBatchSize) {
                    break;
                }
                if (this.tickBufferSize + job.responseSize >= this.tickSizeMax) {
                    continue;
                }
                this.tickLazy.splice(this.tickLazy.indexOf(job), 1);
                this.tickBuffer.push(job);
                this.tickBufferSize += job.responseSize;
            }
        }
        if (this.tickBuffer.length === 0) {
            return;
        }
        const sending = this.tickBuffer.splice(0, this.tickBuffer.length);
        this.clearPackBuffer();
        await this.sendJobs(sending, sending.length > 1);
    }

    /**
     * Flush before an unscoped or oversized GET so already-packed GETACKs
     * are applied before a later send can fail. Otherwise queue until the
     * byte or command budget would overflow.
     */
    private async packOrSendJob(job: JobState): Promise<void> {
        if (isUnscoped(job) || job.responseSize >= this.tickSizeMax || this.tickBatchSize < 2) {
            if (this.tickBuffer.length > 0) {
                await this.flushPackBuffer();
            }
            await this.sendJobs([job], false);
            return;
        }
        if (this.tickBuffer.length > 0 && this.tickBufferSize + job.responseSize > this.tickSizeMax) {
            await this.flushPackBuffer();
        }
        this.tickBuffer.push(job);
        this.tickBufferSize += job.responseSize;
        if (this.tickBuffer.length >= this.tickBatchSize) {
            await this.flushPackBuffer();
        }
    }

    /**
     * Flush Control.Multiple as it fills so a later GET cannot drop GETACKs
     * already on the wire. Cloud MQTT spends one publish per cycle unless a
     * namespace is past its cloud period.
     *
     * `skipAll` is the post-NS_ALL-probe walk: All (including digest fallback)
     * is skipped because that GET already ran.
     */
    private async runOnlineTick(skipAll = false): Promise<void> {
        this.resetTickState();

        if (!skipAll) {
            const allJob = this.jobs.get(SYSTEM_ALL_NAMESPACE);
            if (allJob?.strategy === 'all') {
                // Cloud-only devices never had a host; only probe when HTTP
                // had been preferred and then dropped.
                const due = allJob.nextMs === null
                    || (this.tickEpoch >= allJob.nextMs && (!this.tickMqttActive || this.httpDown()));
                if (due) {
                    await this.packOrSendJob(allJob);
                } else if (!this.tickMqttActive) {
                    for (const job of this.jobs.values()) {
                        if (job.strategy === 'digest') {
                            await this.packOrSendJob(job);
                        }
                    }
                }
            }
        }

        for (const job of this.jobs.values()) {
            switch (job.strategy) {
                case 'all':
                case 'digest':
                    break;
                case 'default':
                    if (this.tickMqttActive && job.nextMs !== null) {
                        break;
                    }
                    await this.packOrSendJob(job);
                    break;
                case 'smart':
                    if (job.nextMs !== null && this.tickEpoch < job.nextMs) {
                        this.tickLazy.push(job);
                        break;
                    }
                    if (!allowSmartpoll(job, this.tickEpoch, this.tickCloudPath, this.tickQueuedCloud)) {
                        this.tickLazy.push(job);
                        break;
                    }
                    await this.packOrSendJob(job);
                    break;
                case 'once':
                    if (job.nextMs !== null) {
                        break;
                    }
                    if (!allowSmartpoll(job, this.tickEpoch, this.tickCloudPath, this.tickQueuedCloud)) {
                        break;
                    }
                    await this.packOrSendJob(job);
                    break;
            }
        }

        await this.flushPackBuffer();
    }
}
