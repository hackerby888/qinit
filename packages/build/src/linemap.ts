// Build-time line map for source-mapped trap backtraces (#2 part C). At -O0 -g every instruction has a
// source line, so this resolves 100% of trap offsets. WAMR (classic) reports `ip - module->load_addr` =
// the wasm FILE offset; the DWARF line table + DW_AT_low_pc are in a compressed "code" space. The shift
// between them is constant per module: base = (objdump function file-start) - (its DW_AT_low_pc). Then
// dwarfAddr = fileOffset - base, and we precompute fileOffset -> {file,line,col,func} for every line row.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export interface LineEntry { off: number; file: string; line: number; col: number; func: string; }
export interface LineMap { base: number; entries: LineEntry[]; } // entries sorted by off ascending

function run(bin: string, args: string[]): string | null {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 << 20 });
  return r.status === 0 ? r.stdout : null;
}

export function buildLineMap(wasm: string, tools: { objdump: string; dwarfdump: string }): LineMap | null {
  const od = run(tools.objdump, ["-d", wasm]);
  const dInfo = run(tools.dwarfdump, ["--debug-info", wasm]);
  const dLine = run(tools.dwarfdump, ["--debug-line", wasm]);
  if (!od || !dInfo || !dLine) return null;

  // function file-starts + names from objdump labels (e.g. "000000c9 <do_div>:")
  const labels: [number, string][] = [];
  for (const ln of od.split("\n")) { const m = ln.match(/^([0-9a-fA-F]+) <(.+?)>:/); if (m && m[2] !== "CODE") labels.push([parseInt(m[1], 16), m[2]]); }
  labels.sort((a, b) => a[0] - b[0]);

  // subprogram DW_AT_low_pc + name (in order) from debug-info
  const subs: { low?: number; name?: string }[] = []; let cur: any = null;
  for (const ln of dInfo.split("\n")) {
    if (ln.includes("DW_TAG_subprogram")) { cur = {}; subs.push(cur); }
    else if (cur) {
      const m = ln.match(/DW_AT_low_pc\s+\(0x([0-9a-fA-F]+)\)/); if (m && cur.low === undefined) cur.low = parseInt(m[1], 16);
      const n = ln.match(/DW_AT_name\s+\("(.+?)"\)/); if (n && cur.name === undefined) cur.name = n[1];
    }
  }
  const byName = new Map(labels.map(([o, n]) => [n, o]));
  // base = (objdump function file-start) − (DW_AT_low_pc), the same constant for every function. A few
  // entries can disagree (duplicate names, odd local-decl encodings), so take the MODE: the dominant value.
  const votes = new Map<number, number>();
  for (const s of subs) {
    if (s.low === undefined || !s.name || !byName.has(s.name)) continue;
    const b = byName.get(s.name)! - s.low;
    votes.set(b, (votes.get(b) ?? 0) + 1);
  }
  if (!votes.size) return null;
  let base = 0, bestVotes = -1;
  for (const [b, c] of votes) if (c > bestVotes) { bestVotes = c; base = b; }

  // --debug-line emits one program per CU; file_names indices are PER-program, so reset the file table at
  // each `debug_line[0x..]` boundary and resolve each row's File column against its own program's table.
  const entries: LineEntry[] = [];
  const fnAt = (off: number) => { let n = "?"; for (const [o, nm] of labels) { if (o <= off) n = nm; else break; } return n; };
  let files = new Map<number, string>(); let pend: number | null = null; let inRows = false;
  for (const ln of dLine.split("\n")) {
    if (/debug_line\[0x/.test(ln)) { files = new Map(); pend = null; inRows = false; continue; }
    const fm = ln.match(/file_names\[\s*(\d+)\]/); if (fm) { pend = Number(fm[1]); continue; }
    if (pend !== null) { const nm = ln.match(/name:\s+"(.+?)"/); if (nm) { files.set(pend, nm[1]); pend = null; } continue; }
    if (/^Address\s+Line\s+Column\s+File/.test(ln)) { inRows = true; continue; }
    if (!inRows) continue;
    const m = ln.match(/^\s*0x([0-9a-fA-F]{16})\s+(\d+)\s+(\d+)\s+(\d+)/); // addr line col file
    if (!m || Number(m[2]) === 0) continue;
    const off = parseInt(m[1], 16) + base;
    entries.push({ off, file: files.get(Number(m[4])) ?? "", line: Number(m[2]), col: Number(m[3]), func: fnAt(off) });
  }
  entries.sort((a, b) => a.off - b.off);
  return { base, entries };
}

export function writeLineMap(wasm: string, outJson: string, tools: { objdump: string; dwarfdump: string }): boolean {
  const lm = buildLineMap(wasm, tools);
  if (!lm) return false;
  writeFileSync(outJson, JSON.stringify(lm));
  return true;
}
