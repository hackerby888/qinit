// Source-mapped trap backtrace resolver (#2 part C). A contract trap on the dev node (built with
// -DLITE_WASM_TRAP_BACKTRACE=ON: classic interp + DUMP_CALL_STACK) makes WAMR auto-print a backtrace to
// node.log:  #00: 0x0000f1 - $f1   /   #01: 0x0000af - dispatch   /   Exception: integer divide by zero
// WAMR's offset is `ip - module->load_addr` = the wasm FILE offset. We map each offset -> source via the
// build-time line map (qinit build emits <name>.lines.json from the -O0 -g sidecar; 100% line coverage)
// and decode the raw exception to a plain cause.

import { existsSync, readFileSync } from "node:fs";

export interface TrapFrame { off: number; func: string; file?: string; line?: number; col?: number; }
export interface TrapBacktrace { exception: string; cause: string; frames: TrapFrame[]; }
interface LineEntry { off: number; file: string; line: number; col: number; func: string; }

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
  for (const [re, msg] of TRAP_CAUSES) if (re.test(exception)) return msg;
  return exception.trim() || "trap";
}

// WAMR reports the ip AFTER the faulting instruction; step back one byte to land inside it, then take the
// last line-map entry at/below that offset (entries are sorted; binary search).
function lookup(entries: LineEntry[], off: number): LineEntry | null {
  const t = off - 1; let lo = 0, hi = entries.length - 1, best: LineEntry | null = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (entries[m].off <= t) { best = entries[m]; lo = m + 1; } else hi = m - 1; }
  return best;
}

export interface ResolveOpts { lineMapPath?: string; }

// Parse node.log: pull each WAMR auto-dump block (the `#NN: 0xOFF - name` frames + the nearest `Exception:`
// line), map offsets via the line map when given. Returns the LAST (most recent) trap in the log, or null.
export function resolveTrapBacktrace(logText: string, opts: ResolveOpts = {}): TrapBacktrace | null {
  const blocks: { frames: TrapFrame[]; exception: string }[] = [];
  let cur: TrapFrame[] = [];
  const flush = (exc: string) => { if (cur.length) { blocks.push({ frames: cur, exception: exc }); cur = []; } };
  for (const ln of logText.split("\n")) {
    const fm = ln.match(/#(\d+):\s+0x([0-9a-fA-F]+)\s+-\s+(.+?)\s*$/);
    if (fm) { cur.push({ off: parseInt(fm[2], 16), func: fm[3] }); continue; }
    const em = ln.match(/Exception:\s+(.+?)\s*$/) || ln.match(/dispatch trap .*?—\s*(.+?)\s*$/);
    if (em && cur.length) flush(em[1]);
  }
  flush("");
  if (!blocks.length) return null;
  const b = blocks[blocks.length - 1];

  let entries: LineEntry[] | null = null;
  if (opts.lineMapPath && existsSync(opts.lineMapPath)) {
    try { const j = JSON.parse(readFileSync(opts.lineMapPath, "utf8")); if (Array.isArray(j.entries)) entries = j.entries; } catch {}
  }
  const frames = b.frames.map((f) => {
    const e = entries ? lookup(entries, f.off) : null;
    return e ? { off: f.off, func: e.func, file: e.file || undefined, line: e.line, col: e.col } : f;
  });
  return { exception: b.exception, cause: decodeTrapCause(b.exception), frames };
}

// One-line-per-frame render for `debug` / `call` / `test` failure output.
export function formatTrapBacktrace(bt: TrapBacktrace): string {
  const out = [`✗ trap: ${bt.cause}` + (bt.exception && bt.cause !== bt.exception ? `  (${bt.exception})` : "")];
  bt.frames.forEach((f, i) => {
    const base = f.file ? f.file.replace(/^.*\//, "") : "";
    const where = base && f.line ? `  ${base}:${f.line}${f.col ? ":" + f.col : ""}` : "";
    out.push(`  ${i === 0 ? "at" : "← "} ${f.func}${where}`);
  });
  return out.join("\n");
}
