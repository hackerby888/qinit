// Records VirtualNode debug traces for CLI and IDE inspection.
import { toHex } from "./k12";
import type { DebugEntry, DebugTrace, DebugStateRegion } from "@qinit/core";

export const TRACE_STATE_CAP = 256 * 1024; // bound the per-entry state scan (node caps too)
const ENTRY_CAP = 4096; // ring-buffer the entries so a long session can't grow unbounded

// Contiguous changed-byte runs between two equal-length state snapshots -> DebugStateRegion[].
export function diffRegions(before: Uint8Array, after: Uint8Array): DebugStateRegion[] {
  const out: DebugStateRegion[] = [];
  const n = Math.min(before.length, after.length);
  let i = 0;
  while (i < n) {
    if (before[i] === after[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && before[i] !== after[i]) {
      i++;
    }
    out.push({
      off: start,
      before: toHex(before.slice(start, i)),
      after: toHex(after.slice(start, i)),
    });
  }
  return out;
}

export interface TraceBeginMetadata {
  tick: number;
  index: number;
  entry: number;
  kind: number;
  invocator: Uint8Array | undefined;
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

  trace(): DebugTrace {
    return { enabled: this.enabled, entries: this.entries };
  }

  begin(metadata: TraceBeginMetadata): DebugEntry | null {
    if (!this.enabled) {
      return null;
    }
    const stateSize = metadata.stateSize;
    const e: DebugEntry = {
      seq: this.seq++,
      tick: metadata.tick,
      index: metadata.index,
      entry: metadata.entry,
      kind: metadata.kind,
      ok: true,
      execNs: 0,
      inSize: metadata.input.length,
      outSize: 0,
      stateSize,
      stateTruncated: stateSize > TRACE_STATE_CAP,
      invocator: metadata.invocator
        ? toHex(metadata.invocator.subarray(0, 32))
        : "0".repeat(64),
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

  end(
    entry: DebugEntry | null,
    metadata: TraceEndMetadata,
  ): void {
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
    const cap = Math.min(
      metadata.stateBefore.length,
      metadata.stateAfter.length,
      TRACE_STATE_CAP,
    );
    entry.stateDiff = diffRegions(
      metadata.stateBefore.subarray(0, cap),
      metadata.stateAfter.subarray(0, cap),
    );

    this.stack.pop();
    this.entries.push(entry);
    if (this.entries.length > ENTRY_CAP) {
      this.entries.splice(0, this.entries.length - ENTRY_CAP);
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
