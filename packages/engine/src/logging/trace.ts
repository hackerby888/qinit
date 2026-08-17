// Records VirtualNode debug traces for CLI and IDE inspection.
import { toHex } from "../support/k12";
import type { DebugEntry, DebugTrace, DebugStateRegion } from "@qinit/core";
import type { Id } from "../support/bytes";

export const TRACE_ENTRY_CAP = 8192; // ring-buffer the entries so a long session can't grow unbounded
// Changed bytes alone rarely spell a whole value — writing 3870 into a zeroed uint64 dirties two bytes.
// Reporting the window around them lets the reader decode the element those bytes belong to.
export const DIFF_WINDOW = 256;

export function diffRegions(before: Uint8Array, after: Uint8Array): DebugStateRegion[] {
    const length = Math.min(before.length, after.length);
    const windows: { start: number; end: number }[] = [];

    for (let index = 0; index < length; index++) {
        if (before[index] === after[index]) {
            continue;
        }

        const start = index - (index % DIFF_WINDOW);
        const end = Math.min(start + DIFF_WINDOW, length);
        const last = windows[windows.length - 1];
        if (last?.end === start) {
            last.end = end;
        } else if (!last || last.end < start) {
            windows.push({ start, end });
        }

        index = end - 1; // the rest of this window is already covered
    }

    return windows.map((window) => ({
        off: window.start,
        before: toHex(before.slice(window.start, window.end)),
        after: toHex(after.slice(window.start, window.end)),
    }));
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
}

export interface TraceEndMetadata {
    output: Uint8Array;
    ok: boolean;
    trap?: string;
    stateBefore: Uint8Array;
    stateAfter: Uint8Array;
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
            stateTruncated: metadata.stateBefore.length < stateSize,
            invocator: metadata.invocator ? toHex(metadata.invocator.subarray(0, 32)) : "0".repeat(64),
            invocationReward: Number(metadata.invocationReward),
            inHex: toHex(metadata.input),
            outHex: "",
            stateDiff: [],
            trap: undefined,
            hostCalls: [],
            logs: [],
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
        entry.stateDiff = diffRegions(metadata.stateBefore, metadata.stateAfter);

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

    // A host-ABI call (transfer, inter-contract call, …) from the currently-executing contract.
    hostCall(name: string, detail: string): void {
        const e = this.stack[this.stack.length - 1];
        if (e) {
            e.hostCalls.push({ name, detail });
        }
    }
}
