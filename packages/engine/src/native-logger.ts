import { k12Bytes } from "./k12";

export const LOG_HEADER_SIZE = 26;
export const LOG_TXS_PER_TICK = 4096;
export const LOG_SPECIAL_EVENTS = 6;
export const LOG_RANGES_PER_TICK = LOG_TXS_PER_TICK + LOG_SPECIAL_EVENTS;
export const LOG_SC_INITIALIZE = LOG_TXS_PER_TICK;
export const LOG_SC_BEGIN_EPOCH = LOG_TXS_PER_TICK + 1;
export const LOG_SC_BEGIN_TICK = LOG_TXS_PER_TICK + 2;
export const LOG_SC_END_TICK = LOG_TXS_PER_TICK + 3;
export const LOG_SC_END_EPOCH = LOG_TXS_PER_TICK + 4;
export const LOG_SC_NOTIFICATION = LOG_TXS_PER_TICK + 5;

export interface NativeLogRange {
  fromLogId: bigint;
  length: bigint;
}

const ZERO32 = new Uint8Array(32);

function emptyRanges(): NativeLogRange[] {
  return Array.from({ length: LOG_RANGES_PER_TICK }, () => ({ fromLogId: -1n, length: -1n }));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// Native-shaped, in-memory qLogger storage. Wasm supplies only type + bytes through lhost.logBytes.
export class NativeLogger {
  private records: Array<Uint8Array | null> = [];
  private ranges = new Map<number, NativeLogRange[]>();
  private digests = new Map<number, Uint8Array>();
  private digestInput: Uint8Array[] = [ZERO32];
  private previousDigest = ZERO32;
  private current: { tick: number; txId: number } | null = null;
  private currentRanges = emptyRanges();
  private currentTick = -1;
  private paused = false;
  private lastUpdatedTick = -1;
  private retainedBytes = 0;

  constructor(private readonly maxRetainedBytes = 64 * 1024 * 1024) {}

  begin(tick: number, txId: number): void {
    if (txId < 0 || txId >= LOG_RANGES_PER_TICK) {
      this.current = null;
      return;
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
    if (this.paused || !this.current) return;
    const message = source.slice();
    if (message.length >= 4)
      new DataView(message.buffer, message.byteOffset, message.byteLength).setUint32(
        0,
        contractIndex >>> 0,
        true,
      );
    const logId = BigInt(this.records.length);
    const record = new Uint8Array(LOG_HEADER_SIZE + message.length);
    if (record.length > this.maxRetainedBytes - this.retainedBytes) return;
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
    if (this.current.tick <= this.lastUpdatedTick) {
      this.ranges.set(
        this.current.tick,
        this.currentRanges.map((r) => ({ ...r })),
      );
    }

    // Contract message types are queryable records but do not contribute to core-lite's log-state digest.
    if (![4, 5, 6, 7].includes(type & 0xff)) this.digestInput.push(message);
  }

  finalizeTick(tick: number): void {
    if (this.currentTick !== tick) {
      this.currentTick = tick;
      this.currentRanges = emptyRanges();
      this.digestInput = [this.previousDigest];
    }
    this.ranges.set(
      tick,
      this.currentRanges.map((r) => ({ ...r })),
    );
    const digest = k12Bytes(concat(this.digestInput));
    this.digests.set(tick, digest);
    this.previousDigest = new Uint8Array(digest);
    this.lastUpdatedTick = tick;
    this.current = null;
    this.paused = false;
  }

  range(tick: number, txId: number): NativeLogRange {
    if (tick > this.lastUpdatedTick) return { fromLogId: -3n, length: -3n };
    return this.ranges.get(tick)?.[txId] ?? { fromLogId: -2n, length: -2n };
  }

  tickRanges(tick: number): NativeLogRange[] {
    if (tick > this.lastUpdatedTick)
      return Array.from({ length: LOG_RANGES_PER_TICK }, () => ({ fromLogId: -3n, length: -3n }));
    return (
      this.ranges.get(tick)?.map((r) => ({ ...r })) ??
      Array.from({ length: LOG_RANGES_PER_TICK }, () => ({ fromLogId: -2n, length: -2n }))
    );
  }

  digest(tick: number): Uint8Array | null {
    return this.digests.get(tick)?.slice() ?? null;
  }

  recordsBetween(from: bigint, to: bigint, maxBytes = 0xffffff - 8): Uint8Array | null {
    if (from < 0n || to < from || to >= BigInt(this.records.length)) return null;
    const parts: Uint8Array[] = [];
    let size = 0;
    for (let id = from; id <= to; id++) {
      const record = this.records[Number(id)];
      if (!record) return null;
      if (size + record.length > maxBytes) break;
      parts.push(record);
      size += record.length;
    }
    return parts.length ? concat(parts) : null;
  }

  prune(from: bigint, to: bigint): number {
    if (from < 0n || to < from || to >= BigInt(this.records.length)) return 4;
    for (let id = from; id <= to; id++) {
      const record = this.records[Number(id)];
      if (record) this.retainedBytes -= record.length;
      this.records[Number(id)] = null;
    }
    return 0;
  }
}
