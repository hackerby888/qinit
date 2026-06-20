// Debug-trace recorder for the in-process engine — fills the DebugEntry/DebugTrace shape the node's RPC
// returns, so `qinit debug`/`call --trace`/`state` and the browser IDE's tx inspector light up against
// the TS engine too (they already decode this shape via the shared trace-format decoder). Opt-in
// (setDebug) — a no-op with zero overhead when disabled. One entry per Contract.invoke (top-level tx,
// query, sysproc, or a nested inter-contract call), nesting tracked by a stack.
import { toHex } from "./k12";
import type { DebugEntry, DebugTrace, DebugStateRegion } from "@qinit/core";

const STATE_CAP = 256 * 1024; // bound the per-entry state scan (node caps too)
const ENTRY_CAP = 4096;       // ring-buffer the entries so a long session can't grow unbounded

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
    out.push({ off: start, before: toHex(before.slice(start, i)), after: toHex(after.slice(start, i)) });
  }
  return out;
}

export interface BeginMeta {
  tick: number;
  index: number;
  entry: number;
  kind: number;
  invocator: Uint8Array | undefined;
  invocationReward: bigint;
  input: Uint8Array;
  stateBefore: Uint8Array;
}

export interface EndMeta {
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

  begin(m: BeginMeta): DebugEntry | null {
    if (!this.enabled) {
      return null;
    }
    const stateSize = m.stateBefore.length;
    const e: DebugEntry = {
      seq: this.seq++,
      tick: m.tick,
      index: m.index,
      entry: m.entry,
      kind: m.kind,
      ok: true,
      execNs: 0,
      inSize: m.input.length,
      outSize: 0,
      stateSize,
      stateTruncated: stateSize > STATE_CAP,
      invocator: m.invocator ? toHex(m.invocator.subarray(0, 32)) : "0".repeat(64),
      invocationReward: Number(m.invocationReward),
      inHex: toHex(m.input),
      outHex: "",
      stateDiff: [],
      trap: undefined,
      hostCalls: [],
      logs: [],
    };
    this.stack.push(e);
    return e;
  }

  end(e: DebugEntry | null, m: EndMeta): void {
    if (!e) {
      return;
    }
    e.outHex = toHex(m.output);
    e.outSize = m.output.length;
    e.ok = m.ok;
    e.execNs = m.execNs;
    if (m.trap) {
      e.trap = m.trap;
    }
    const cap = Math.min(m.stateBefore.length, STATE_CAP);
    e.stateDiff = diffRegions(m.stateBefore.subarray(0, cap), m.stateAfter.subarray(0, cap));

    this.stack.pop();
    this.entries.push(e);
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
