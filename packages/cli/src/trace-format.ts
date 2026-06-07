// Shared decode of a contract's state + a debug-trace entry — used by `qinit debug` (TUI), `qinit call --trace`
// (inline post-call view) and `qinit state` (standalone dump). Keeps the field/container/log decoding in ONE
// place so all three stay consistent. RPC dep is the narrow StateReader (real LiteRpc / a fake in tests).
import { decodeOutput, layoutOf, decodeHashMap, decodeHashSet, decodeCollection, decodeLog, type DecodedLog } from "@qinit/proto";
import { extractIdl } from "@qinit/build";
import { bytesToIdentity, type DebugEntry } from "@qinit/core";

export type Container = { kind: "hashmap" | "hashset" | "collection"; keyFmt: string; valFmt?: string; capacity: number };
export type StateField = { name: string; off: number; size: number; type: string; container?: Container; bad?: boolean };
export type ColView = { name: string; entries: string[] };
export type StateReader = { stateRead(slot: number, off: number, len: number): Promise<{ hex: string }> };

const roundUp = (o: number, a: number) => (a <= 1 ? o : Math.ceil(o / a) * a);
export const hexToBytes = (h: string) => { const s = h.startsWith("0x") ? h.slice(2) : h; const a = new Uint8Array(s.length >> 1); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };
export const jstr = (v: any) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// Compact array formatter: run-length-group consecutive equal values ("0 ×100") and cap the number of shown
// items unless `full` (--all). Keeps short arrays/structs literal so e.g. Fees [0,0,0] reads normally.
const RUN_MIN = 6, MAX_ITEMS = 32;
export function fmtVal(v: any, full = false): string {
  if (Array.isArray(v)) {
    const g: { s: string; n: number }[] = [];
    for (const el of v) { const s = fmtVal(el, full); const last = g[g.length - 1]; if (last && last.s === s) last.n++; else g.push({ s, n: 1 }); }
    let parts = g.flatMap((x) => (x.n >= RUN_MIN ? [`${x.s} ×${x.n}`] : Array(x.n).fill(x.s)));
    let more = "";
    if (!full && parts.length > MAX_ITEMS) { more = `, … +${parts.length - MAX_ITEMS} more (--all)`; parts = parts.slice(0, MAX_ITEMS); }
    return `[${parts.join(", ")}${more}]`;
  }
  if (v && typeof v === "object") return jstr(v);
  if (typeof v === "string") return JSON.stringify(v);
  return typeof v === "bigint" ? v.toString() : String(v);
}
export const keyLabel = (k: unknown) => (typeof k === "string" ? k : jstr(k));   // full id/string (copy-pasteable); jstr for numeric keys

// per-field StateData layout walk (alignment-aware) — names a changed byte offset + locates container fields.
// A single struct-typed field uses per-field layoutOf (NOT join+structFieldOffsets, which unwraps it wrong).
export function stateFieldsOf(idl: { state?: { name: string; type: string; container?: Container }[] }): StateField[] {
  let acc = 0; const out: StateField[] = [];
  for (const f of idl.state ?? []) {
    let L: { size: number; align: number };
    // unsizable type (e.g. a field whose size depends on an external #define) -> mark + stop: later offsets are unknown.
    try { L = layoutOf(f.type); } catch { out.push({ name: f.name, off: acc, size: 0, type: f.type, container: f.container, bad: true }); break; }
    acc = roundUp(acc, L.align); out.push({ name: f.name, off: acc, size: L.size, type: f.type, container: f.container }); acc += L.size;
  }
  return out;
}

export function labelOff(fields: StateField[], off: number): string {
  const f = fields.find((x) => off >= x.off && off < x.off + x.size);
  return f ? f.name + (off > f.off ? "+" + (off - f.off) : "") : "@" + off;
}

// Format a changed-byte run for the state diff. Integer fields -> decimal (the run is little-endian, e.g. "64" -> 100);
// everything else (id / m256i / raw bytes) stays hex so it's still copy-pasteable.
const isIntType = (t: string) => /^(uint|sint)(8|16|32|64)$/.test(t) || t === "bit";
export function fmtDiffVal(fields: StateField[], off: number, hex: string): string {
  const f = fields.find((x) => off >= x.off && off < x.off + x.size);
  if (!f || !isIntType(f.type) || !/^[0-9a-fA-F]+$/.test(hex)) return hex;
  let v = 0n;
  for (let i = 0; i + 1 < hex.length; i += 2) v |= BigInt(parseInt(hex.slice(i, i + 2), 16)) << BigInt((i / 2) * 8);
  return v.toString();
}

// log _type -> enum name map; log-named enums applied last so they win value collisions with unrelated enums.
export function enumMap(idl: { enums?: { name: string; members: Record<string, string> }[] }): Record<string, string> {
  const m: Record<string, string> = {};
  for (const en of idl.enums ?? []) if (!/log/i.test(en.name)) Object.assign(m, en.members);
  for (const en of idl.enums ?? []) if (/log/i.test(en.name)) Object.assign(m, en.members);
  return m;
}

// decode each container field's CURRENT contents via state-read (capped 256KB), to logical entries.
export async function decodeColumns(rpc: StateReader, idx: number, fields: StateField[], full = false): Promise<ColView[]> {
  const out: ColView[] = [];
  for (const f of fields) {
    if (!f.container) continue;
    try {
      const sr = await rpc.stateRead(idx, f.off, Math.min(f.size, 262144));
      const buf = hexToBytes(sr.hex); const c = f.container;
      const ents = c.kind === "hashmap"
        ? (await decodeHashMap(buf, c.keyFmt, c.valFmt!, c.capacity)).map((x) => `${keyLabel(x.key)} = ${fmtVal(x.value, full)}`)
        : c.kind === "collection"
          ? (await decodeCollection(buf, c.valFmt!, c.capacity)).map((x) => `${keyLabel(x.pov)}: ${fmtVal(x.value, full)} (p${x.priority})`)
          : (await decodeHashSet(buf, c.keyFmt, c.capacity)).map((x) => keyLabel(x.key));
      const cap = full ? Infinity : 10;
      out.push({ name: f.name, entries: ents.length > cap ? ents.slice(0, cap).concat(`… +${ents.length - cap} more (--all)`) : ents });
    } catch {}
  }
  return out;
}

export const sevColor = (s: string) => (s === "ERROR" ? "red" : s === "WARN" ? "yellow" : s === "INFO" ? "green" : undefined);
export const fmtLog = (l: DecodedLog) => `${l.severity} ${l.name ? l.name + (l.typeName ? "·" + l.typeName : "") + " " + jstr(l.fields) : l.size + "B " + l.hex.slice(0, 34) + "…"}`;

export interface TraceView { inDecoded: string; outDecoded: string; caller: string; fields: StateField[]; cols: ColView[]; logs: DecodedLog[] }

// Decode one debug-trace entry: input/output, caller identity, StateData field map (for the diff), container
// contents, and the contract LOG_* records. `source` = the contract .h (from the dyn-registry); none -> hex.
export async function describeTrace(e: DebugEntry, source: string | undefined, name: string, rpc: StateReader): Promise<TraceView> {
  let inS = e.inHex ? "0x" + e.inHex : "(none)";
  let outS = e.outHex ? "0x" + e.outHex : "(none)";
  let caller = "(none)";
  if (e.kind === 1 && !/^0+$/.test(e.invocator)) { try { caller = await bytesToIdentity(hexToBytes(e.invocator)); } catch { caller = "0x" + e.invocator.slice(0, 16) + "…"; } }
  let fields: StateField[] = []; let cols: ColView[] = []; let logs: DecodedLog[] = [];
  if (source) {
    try {
      const idl = extractIdl(source, name);
      const ent: any = (e.kind === 0 ? idl.functions : idl.procedures)?.[String(e.entry)];
      if (ent?.in && e.inHex) inS = jstr(await decodeOutput(hexToBytes(e.inHex), ent.in));
      if (ent?.out && e.outHex) outS = jstr(await decodeOutput(hexToBytes(e.outHex), ent.out));
      fields = stateFieldsOf(idl);
      cols = await decodeColumns(rpc, e.index, fields);
      const em = enumMap(idl);
      if (e.logs?.length) logs = await Promise.all(e.logs.map((l) => decodeLog(l.type, l.size, l.hex, idl.logStructs ?? [], em)));
    } catch {}
  }
  return { inDecoded: inS, outDecoded: outS, caller, fields, cols, logs };
}

// Decode a contract's FULL current state: scalar fields (decoded to values) + containers (logical entries).
export interface StateDump { fields: { name: string; value: string }[]; cols: ColView[] }
export async function readState(rpc: StateReader, idx: number, source: string, name: string, full = false): Promise<StateDump> {
  const idl = extractIdl(source, name);
  const fields = stateFieldsOf(idl);
  const scalars: { name: string; value: string }[] = [];
  for (const f of fields) {
    if (f.bad) { scalars.push({ name: f.name, value: `(undecodable: ${f.type} — fields below not shown)` }); continue; }
    if (f.container) continue;                               // containers shown via decodeColumns below
    try {
      const dv = await decodeOutput(hexToBytes((await rpc.stateRead(idx, f.off, Math.min(f.size, 262144))).hex), f.type);
      scalars.push({ name: f.name, value: typeof dv === "object" && dv !== null ? fmtVal(dv, full) : String(dv) });  // bare scalar unquoted; struct/array run-length-grouped
    } catch { scalars.push({ name: f.name, value: "(read failed)" }); }
  }
  return { fields: scalars, cols: await decodeColumns(rpc, idx, fields, full) };
}
