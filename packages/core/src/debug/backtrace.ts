// Core-lite's classic interpreter and call-stack capture print a contract trap backtrace to
// the node log; this resolver maps its Wasm offsets through Qinit's DWARF sidecar.

import { existsSync, readFileSync } from "node:fs";

export interface TrapFrame {
  off: number;
  func: string;
  file?: string;
  line?: number;
  col?: number;
}
export interface TrapBacktrace {
  exception: string;
  cause: string;
  frames: TrapFrame[];
}
interface LineEntry {
  off: number;
  file: string;
  line: number;
  col: number;
  func: string;
}

// Raw WAMR/runtime exception -> plain-language cause (+ the QPI gotcha where relevant).
const TRAP_CAUSES: [RegExp, string][] = [
  [/divide by zero|integer.*zero/i, "divide / mod by zero — use QPI div() / mod()"],
  [/out of bounds|memory access/i, "out-of-range access — array or state index past its bounds"],
  [/unreachable/i, "reached an abort / failed assert (unreachable)"],
  [/call stack exhausted|stack overflow/i, "stack overflow — unbounded recursion"],
  [/invalid exec env|exec_env/i, "engine error (not the contract) — please report"],
  [/indirect call|undefined element|uninitialized element/i, "bad indirect call (function table)"],
];
export function decodeTrapCause(exception: string): string {
  for (const [pattern, message] of TRAP_CAUSES) {
    if (pattern.test(exception)) return message;
  }
  return exception.trim() || "trap";
}

// WAMR reports the ip AFTER the faulting instruction; step back one byte to land inside it, then take the
// last line-map entry at/below that offset (entries are sorted; binary search).
function lookup(entries: LineEntry[], off: number): LineEntry | null {
  const target = off - 1;
  let low = 0;
  let high = entries.length - 1;
  let best: LineEntry | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (entries[middle].off <= target) {
      best = entries[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export interface ResolveOpts {
  lineMapPath?: string;
}

// Parse node.log: pull each WAMR auto-dump block (the `#NN: 0xOFF - name` frames + the nearest `Exception:`
// line), map offsets via the line map when given. Returns the LAST (most recent) trap in the log, or null.
export function resolveTrapBacktrace(
  logText: string,
  opts: ResolveOpts = {},
): TrapBacktrace | null {
  const blocks: { frames: TrapFrame[]; exception: string }[] = [];
  let currentFrames: TrapFrame[] = [];
  const flush = (exception: string) => {
    if (currentFrames.length) {
      blocks.push({ frames: currentFrames, exception });
      currentFrames = [];
    }
  };
  for (const line of logText.split("\n")) {
    const frameMatch = line.match(/#(\d+):\s+0x([0-9a-fA-F]+)\s+-\s+(.+?)\s*$/);
    if (frameMatch) {
      currentFrames.push({ off: parseInt(frameMatch[2], 16), func: frameMatch[3] });
      continue;
    }
    const exceptionMatch =
      line.match(/Exception:\s+(.+?)\s*$/) || line.match(/dispatch trap .*?—\s*(.+?)\s*$/);
    if (exceptionMatch && currentFrames.length) flush(exceptionMatch[1]);
  }
  flush("");
  if (!blocks.length) return null;
  const latest = blocks[blocks.length - 1];

  let entries: LineEntry[] | null = null;
  if (opts.lineMapPath && existsSync(opts.lineMapPath)) {
    try {
      const lineMap = JSON.parse(readFileSync(opts.lineMapPath, "utf8"));
      if (Array.isArray(lineMap.entries)) entries = lineMap.entries;
    } catch {}
  }
  const frames = latest.frames.map((frame) => {
    const entry = entries ? lookup(entries, frame.off) : null;
    return entry
      ? {
          off: frame.off,
          func: entry.func,
          file: entry.file || undefined,
          line: entry.line,
          col: entry.col,
        }
      : frame;
  });
  return {
    exception: latest.exception,
    cause: decodeTrapCause(latest.exception),
    frames,
  };
}

// One-line-per-frame render for `debug` / `call` / `test` failure output.
export function formatTrapBacktrace(bt: TrapBacktrace): string {
  const out = [
    `✗ trap: ${bt.cause}` +
      (bt.exception && bt.cause !== bt.exception ? `  (${bt.exception})` : ""),
  ];
  bt.frames.forEach((f, i) => {
    const base = f.file ? f.file.replace(/^.*\//, "") : "";
    const where = base && f.line ? `  ${base}:${f.line}${f.col ? ":" + f.col : ""}` : "";
    out.push(`  ${i === 0 ? "at" : "← "} ${f.func}${where}`);
  });
  return out.join("\n");
}
