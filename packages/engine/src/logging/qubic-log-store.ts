import { k12Bytes } from "../support/k12";
import { concatBytes } from "../support/bytes";
import { QUBIC_LOG_TYPE, TXS_PER_TICK } from "@qinit/proto";

export const LOG_HEADER_SIZE = 26;
export const LOG_TXS_PER_TICK = TXS_PER_TICK;
export const LOG_SPECIAL_EVENTS = 6;
export const LOG_RANGES_PER_TICK = LOG_TXS_PER_TICK + LOG_SPECIAL_EVENTS;
export const LOG_SC_INITIALIZE = LOG_TXS_PER_TICK;
export const LOG_SC_BEGIN_EPOCH = LOG_TXS_PER_TICK + 1;
export const LOG_SC_BEGIN_TICK = LOG_TXS_PER_TICK + 2;
export const LOG_SC_END_TICK = LOG_TXS_PER_TICK + 3;
export const LOG_SC_END_EPOCH = LOG_TXS_PER_TICK + 4;
export const LOG_SC_NOTIFICATION = LOG_TXS_PER_TICK + 5;

export interface QubicLogRange {
    fromLogId: bigint;
    length: bigint;
}

const ZERO32 = new Uint8Array(32);
// Core qLogger digests only spectrum and universe mutation records.
const DIGEST_MESSAGE_TYPES = new Set<number>([
    QUBIC_LOG_TYPE.QU_TRANSFER,
    QUBIC_LOG_TYPE.ASSET_ISSUANCE,
    QUBIC_LOG_TYPE.ASSET_OWNERSHIP_CHANGE,
    QUBIC_LOG_TYPE.ASSET_POSSESSION_CHANGE,
    QUBIC_LOG_TYPE.BURNING,
    QUBIC_LOG_TYPE.DUST_BURNING,
    QUBIC_LOG_TYPE.SPECTRUM_STATS,
    QUBIC_LOG_TYPE.ASSET_OWNERSHIP_MANAGING_CONTRACT_CHANGE,
    QUBIC_LOG_TYPE.ASSET_POSSESSION_MANAGING_CONTRACT_CHANGE,
]);

interface FinalizedTickRecords {
    tick: number;
    fromLogId: number;
    toLogId: number;
}

function emptyRanges(): QubicLogRange[] {
    return Array.from({ length: LOG_RANGES_PER_TICK }, () => ({
        fromLogId: -1n,
        length: -1n,
    }));
}

// Core-compatible in-memory qLogger storage.
export class QubicLogStore {
    private records: Array<Uint8Array | null> = [];
    private ranges = new Map<number, QubicLogRange[]>();
    private digests = new Map<number, Uint8Array>();
    private digestInput: Uint8Array[] = [ZERO32];
    private previousDigest = ZERO32;
    private current: { tick: number; txId: number } | null = null;
    private currentRanges = emptyRanges();
    private currentTick = -1;
    private paused = false;
    private lastUpdatedTick = -1;
    private retainedBytes = 0;
    private finalizedLogCount = 0;
    private finalizedTicks: FinalizedTickRecords[] = [];
    private tickBegin = 0;
    private overflowedTick: number | null = null;

    constructor(private readonly maxRetainedBytes = 64 * 1024 * 1024) {}

    begin(tick: number, txId: number): void {
        if (txId < 0 || txId >= LOG_RANGES_PER_TICK) {
            this.current = null;
            return;
        }
        if (tick <= this.lastUpdatedTick || tick < this.currentTick) {
            throw new Error(`cannot write logs for finalized tick ${tick}`);
        }
        if (this.overflowedTick !== null) {
            throw new Error(`log retention limit exceeded in tick ${this.overflowedTick}`);
        }
        if (this.currentTick !== tick) {
            this.currentTick = tick;
            this.currentRanges = emptyRanges();
            this.digestInput = [this.previousDigest];
        }
        this.current = { tick, txId };
    }

    end(): void {
        this.current = null;
    }
    pause(): void {
        this.paused = true;
    }
    resume(): void {
        this.paused = false;
    }

    log(contractIndex: number, type: number, source: Uint8Array, epoch: number): void {
        this.append(type, source, epoch, contractIndex);
    }

    logRaw(type: number, source: Uint8Array, epoch: number): void {
        this.append(type, source, epoch);
    }

    private append(type: number, source: Uint8Array, epoch: number, contractIndex?: number): void {
        if (this.paused || !this.current) return;
        if (this.current.tick <= this.lastUpdatedTick) {
            throw new Error(`cannot write logs for finalized tick ${this.current.tick}`);
        }
        const message = source.slice();
        if (contractIndex !== undefined && message.length >= 4) {
            new DataView(message.buffer, message.byteOffset, message.byteLength).setUint32(
                0,
                contractIndex >>> 0,
                true,
            );
        }
        const logId = BigInt(this.records.length);
        const record = new Uint8Array(LOG_HEADER_SIZE + message.length);
        if (!this.reserve(record.length)) return;
        const view = new DataView(record.buffer);
        view.setUint16(0, epoch & 0xffff, true);
        view.setUint32(2, this.current.tick >>> 0, true);
        view.setUint32(6, (message.length & 0xffffff) | ((type & 0xff) << 24), true);
        view.setBigUint64(10, logId, true);
        const digest = k12Bytes(message);
        view.setBigUint64(
            18,
            new DataView(digest.buffer, digest.byteOffset, digest.byteLength).getBigUint64(0, true),
            true,
        );
        record.set(message, LOG_HEADER_SIZE);
        this.records.push(record);
        this.retainedBytes += record.length;

        const range = this.currentRanges[this.current.txId];
        if (range.fromLogId < 0n) {
            range.fromLogId = logId;
            range.length = 1n;
        } else range.length++;

        if (DIGEST_MESSAGE_TYPES.has(type & 0xff)) {
            this.digestInput.push(message);
        }
    }

    finalizeTick(tick: number): void {
        if (tick <= this.lastUpdatedTick || tick < this.currentTick) {
            throw new Error(`cannot finalize logs for tick ${tick} twice`);
        }
        if (this.overflowedTick !== null) {
            this.current = null;
            this.paused = false;
            throw new Error(`log retention limit exceeded in tick ${this.overflowedTick}`);
        }
        if (this.currentTick !== tick) {
            this.currentTick = tick;
            this.currentRanges = emptyRanges();
            this.digestInput = [this.previousDigest];
        }
        this.ranges.set(
            tick,
            this.currentRanges.map((r) => ({ ...r })),
        );
        const digest = k12Bytes(concatBytes(this.digestInput));
        this.digests.set(tick, digest);
        this.previousDigest = new Uint8Array(digest);
        if (this.finalizedLogCount < this.records.length) {
            this.finalizedTicks.push({
                tick,
                fromLogId: this.finalizedLogCount,
                toLogId: this.records.length,
            });
        }
        this.finalizedLogCount = this.records.length;
        this.lastUpdatedTick = tick;
        this.current = null;
        this.paused = false;
    }

    reset(tickBegin = 0): void {
        this.records = [];
        this.ranges.clear();
        this.digests.clear();
        this.digestInput = [ZERO32];
        this.previousDigest = ZERO32;
        this.current = null;
        this.currentRanges = emptyRanges();
        this.currentTick = tickBegin - 1;
        this.paused = false;
        this.lastUpdatedTick = tickBegin - 1;
        this.retainedBytes = 0;
        this.finalizedLogCount = 0;
        this.finalizedTicks = [];
        this.tickBegin = tickBegin;
        this.overflowedTick = null;
    }

    range(tick: number, txId: number): QubicLogRange {
        if (tick > this.lastUpdatedTick) {
            return { fromLogId: -3n, length: -3n };
        }
        if (tick < this.tickBegin) {
            return { fromLogId: -2n, length: -2n };
        }
        return this.ranges.get(tick)?.[txId] ?? { fromLogId: -2n, length: -2n };
    }

    tickRanges(tick: number): QubicLogRange[] {
        if (tick > this.lastUpdatedTick) {
            return Array.from({ length: LOG_RANGES_PER_TICK }, () => ({
                fromLogId: -3n,
                length: -3n,
            }));
        }
        if (tick < this.tickBegin) {
            return Array.from({ length: LOG_RANGES_PER_TICK }, () => ({
                fromLogId: -2n,
                length: -2n,
            }));
        }
        return (
            this.ranges.get(tick)?.map((r) => ({ ...r })) ??
            Array.from({ length: LOG_RANGES_PER_TICK }, () => ({
                fromLogId: -2n,
                length: -2n,
            }))
        );
    }

    digest(tick: number): Uint8Array | null {
        return this.digests.get(tick)?.slice() ?? null;
    }

    recordsBetween(from: bigint, to: bigint, maxBytes = 0xffffff - 8): Uint8Array | null {
        if (from < 0n || to < from || to >= BigInt(this.finalizedLogCount)) {
            return null;
        }
        const parts: Uint8Array[] = [];
        let size = 0;
        for (let id = from; id <= to; id++) {
            const record = this.records[Number(id)];
            if (!record) return null;
            if (size + record.length > maxBytes) break;
            parts.push(record);
            size += record.length;
        }
        return parts.length ? concatBytes(parts) : null;
    }

    prune(from: bigint, to: bigint): number {
        if (from < 0n || to < from || to >= BigInt(this.finalizedLogCount)) {
            return 4;
        }
        for (let id = from; id <= to; id++) {
            const record = this.records[Number(id)];
            if (record) this.retainedBytes -= record.length;
            this.records[Number(id)] = null;
        }
        return 0;
    }

    private reserve(bytes: number): boolean {
        while (
            this.retainedBytes + bytes > this.maxRetainedBytes &&
            this.finalizedTicks.length > 0
        ) {
            this.evictOldestTick();
        }

        if (this.retainedBytes + bytes <= this.maxRetainedBytes) {
            return true;
        }

        this.discardUnfinalizedRecords();
        this.currentRanges = emptyRanges();
        this.digestInput = [this.previousDigest];
        this.overflowedTick = this.current?.tick ?? this.currentTick;
        return false;
    }

    private evictOldestTick(): void {
        const oldest = this.finalizedTicks.shift();
        if (!oldest) return;

        for (let id = oldest.fromLogId; id < oldest.toLogId; id++) {
            const record = this.records[id];
            if (record) this.retainedBytes -= record.length;
            this.records[id] = null;
        }
        this.ranges.delete(oldest.tick);
    }

    private discardUnfinalizedRecords(): void {
        for (let id = this.finalizedLogCount; id < this.records.length; id++) {
            const record = this.records[id];
            if (record) this.retainedBytes -= record.length;
        }
        this.records.length = this.finalizedLogCount;
    }
}
