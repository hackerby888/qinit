// Records VirtualNode debug traces for CLI and IDE inspection.
import { toHex } from "../support/k12";
import type { DebugEntry, DebugTrace, DebugStateRegion } from "@qinit/core";
import { JOURNAL_BLOCK_BYTES, readJournalBlocks, type JournalHeader } from "@qinit/core/wasm/journal";
import { rangesEqual, type Id } from "../support/bytes";

export const TRACE_ENTRY_CAP = 8192; // ring-buffer the entries so a long session can't grow unbounded
// Changed bytes alone rarely spell a whole value — writing 3870 into a zeroed uint64 dirties two bytes.
// Reporting the window around them lets the reader decode the element those bytes belong to.
export const DIFF_WINDOW = 256;

// Scanned in blocks before windows: one memcmp clears 256 windows at a time, and an untouched state —
// the common case every tick — costs a single pass instead of a comparison per byte.
const COARSE_BLOCK = 64 * 1024;

export function diffRegions(before: Uint8Array, after: Uint8Array): DebugStateRegion[] {
    const length = Math.min(before.length, after.length);
    const windows: { start: number; end: number }[] = [];

    for (let block = 0; block < length; block += COARSE_BLOCK) {
        const blockEnd = Math.min(block + COARSE_BLOCK, length);
        if (rangesEqual(before, block, after, block, blockEnd - block)) {
            continue;
        }

        for (let start = block; start < blockEnd; start += DIFF_WINDOW) {
            const end = Math.min(start + DIFF_WINDOW, length);
            if (rangesEqual(before, start, after, start, end - start)) {
                continue;
            }

            const last = windows[windows.length - 1];
            if (last?.end === start) {
                last.end = end;
            } else if (!last || last.end < start) {
                windows.push({ start, end });
            }
        }
    }

    return windows.map((window) => ({
        off: window.start,
        before: toHex(before.slice(window.start, window.end)),
        after: toHex(after.slice(window.start, window.end)),
    }));
}

/**
 * The same regions `diffRegions` produces, from the contract's own write journal instead of a copy of
 * the state. Blocks the contract wrote without changing are dropped before adjacent ones are merged,
 * so a write of an identical value never widens its neighbour's region.
 */
export function journalRegions(memory: Uint8Array, journalBase: number, stateAddr: number, header: JournalHeader): DebugStateRegion[] {
    const changed: { block: number; before: Uint8Array; after: Uint8Array }[] = [];

    for (const entry of readJournalBlocks(memory, journalBase, header)) {
        const liveAt = stateAddr + entry.offset;
        const beforeAt = entry.before.byteOffset - memory.byteOffset;
        if (rangesEqual(memory, beforeAt, memory, liveAt, entry.before.length)) {
            continue;
        }
        changed.push({ block: entry.block, before: entry.before.slice(), after: memory.slice(liveAt, liveAt + entry.before.length) });
    }

    changed.sort((left, right) => left.block - right.block);

    const regions: DebugStateRegion[] = [];
    for (let index = 0; index < changed.length;) {
        let end = index;
        while (end + 1 < changed.length && changed[end + 1]!.block === changed[end]!.block + 1) {
            end++;
        }

        const run = changed.slice(index, end + 1);
        regions.push({
            off: run[0]!.block * JOURNAL_BLOCK_BYTES,
            before: run.map((part) => toHex(part.before)).join(""),
            after: run.map((part) => toHex(part.after)).join(""),
        });
        index = end + 1;
    }

    return regions;
}

export interface TraceBeginMetadata {
    tick: number;
    index: number;
    entry: number;
    kind: number;
    invocator: Id | undefined;
    invocationReward: bigint;
    input: Uint8Array;
    stateSize: number;
    stateBefore: Uint8Array;
    /** Set when the before-image is not a snapshot, so its length says nothing about coverage. */
    stateTruncated?: boolean;
}

export interface TraceEndMetadata {
    output: Uint8Array;
    ok: boolean;
    trap?: string;
    stateBefore: Uint8Array;
    stateAfter: Uint8Array;
    /** Skips the diff scan when the caller already compared the two. Omit when unknown. */
    stateChanged?: boolean;
    /** Regions the caller already resolved, from the contract's write journal rather than a snapshot. */
    stateDiff?: DebugStateRegion[];
    /** Journal overflow: the contract wrote more blocks than the journal could record. */
    stateTruncated?: boolean;
    execNs: number;
}

export class TraceRecorder {
    enabled = false;
    private entries: DebugEntry[] = [];
    private stack: DebugEntry[] = [];
    private seq = 0;

    setEnabled(on: boolean): void {
        this.enabled = on;
    }

    reset(): void {
        this.entries = [];
        this.stack = [];
        this.seq = 0;
    }

    // Same rules as core-lite's traceSnapshot(): one CLI client polls both backends.
    trace(since = 0, limit = TRACE_ENTRY_CAP): DebugTrace {
        const fresh = this.entries.filter((entry) => entry.seq > since);
        const capped = !(limit > 0) || limit > TRACE_ENTRY_CAP ? TRACE_ENTRY_CAP : limit;

        return {
            enabled: this.enabled,
            entries: fresh.length > capped ? fresh.slice(-capped) : fresh,
        };
    }

    begin(metadata: TraceBeginMetadata): DebugEntry | null {
        if (!this.enabled) {
            return null;
        }
        const stateSize = metadata.stateSize;
        const e: DebugEntry = {
            seq: 0,
            tick: metadata.tick,
            index: metadata.index,
            entry: metadata.entry,
            kind: metadata.kind,
            ok: true,
            execNs: 0,
            inSize: metadata.input.length,
            outSize: 0,
            stateSize,
            // Snapshots are whole-state, so this only fires if one came up short.
            stateTruncated: metadata.stateTruncated ?? metadata.stateBefore.length < stateSize,
            invocator: metadata.invocator ? toHex(metadata.invocator.subarray(0, 32)) : "0".repeat(64),
            invocationReward: Number(metadata.invocationReward),
            inHex: toHex(metadata.input),
            outHex: "",
            stateDiff: [],
            trap: undefined,
            hostCalls: [],
            logs: [],
            cheats: [],
        };
        this.stack.push(e);
        return e;
    }

    end(entry: DebugEntry | null, metadata: TraceEndMetadata): void {
        if (!entry) {
            return;
        }
        entry.outHex = toHex(metadata.output);
        entry.outSize = metadata.output.length;
        entry.ok = metadata.ok;
        entry.execNs = metadata.execNs;
        if (metadata.trap) {
            entry.trap = metadata.trap;
        }
        // An unchanged state has no regions by definition, and the caller already had to compare to meter the
        // call — scanning a multi-hundred-megabyte state twice for the same answer is the whole cost.
        entry.stateDiff = metadata.stateDiff ?? (metadata.stateChanged === false ? [] : diffRegions(metadata.stateBefore, metadata.stateAfter));
        if (metadata.stateTruncated !== undefined) {
            entry.stateTruncated = metadata.stateTruncated;
        }

        this.stack.pop();
        entry.seq = ++this.seq;
        this.entries.push(entry);
        if (this.entries.length > TRACE_ENTRY_CAP) {
            this.entries.splice(0, this.entries.length - TRACE_ENTRY_CAP);
        }
    }

    // A LOG_* emission from the currently-executing contract (routed via HostServices.log).
    log(type: number, msg: Uint8Array): void {
        const e = this.stack[this.stack.length - 1];
        if (e) {
            e.logs.push({ type, size: msg.length, hex: toHex(msg) });
        }
    }

    // A CC_PRINT argument. Kept apart from logs: no log id, never reaches the log store. `value` is decimal
    // text because the entry crosses /debug-trace as JSON, and a register-passed scalar has no bytes to fall back on.
    cheat(slot: number, id: number, part: number, value: bigint, bytes: Uint8Array): void {
        const e = this.stack[this.stack.length - 1];
        if (e) {
            e.cheats.push({ slot, id, part, size: bytes.length, value: value.toString(), hex: toHex(bytes) });
        }
    }

    // A host-ABI call (transfer, inter-contract call, …) from the currently-executing contract.
    hostCall(name: string, detail: string): void {
        const e = this.stack[this.stack.length - 1];
        if (e) {
            e.hostCalls.push({ name, detail });
        }
    }
}
