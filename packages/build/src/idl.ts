// Extract an IDL from a qpi.h contract .h: REGISTER_USER_* names + _input/_output
// struct layouts -> codec format strings. Output is keyed to match qinit.idl.json
// (consumed by the interactive `/call` picker): { name, functions:{[inputType]:{name,in,out}},
// procedures:{[inputType]:{name,in}} }. Light regex parse — handles flat structs, Array<T,N>,
// nested structs (one+ levels), id; unknown types pass through verbatim.

// type = codec token (uint64, id, bytes32, [N;T], { ... }); container = QPI HashMap/HashSet meta (for logical decode)
export interface Field { name: string; type: string; container?: { kind: "hashmap" | "hashset" | "collection"; keyFmt: string; valFmt?: string; capacity: number } }
export interface IdlEntry { name: string; in: string; out?: string; inFields: Field[]; outFields?: Field[] }
// A qpi LOG_* struct (ends with `sint8 _terminator`): fmt/fields cover only the members BEFORE the terminator
// (what the node logs). The decoder size-matches a log's byte count against these. fmt = comma-joined types.
export interface LogStruct { name: string; fmt: string; fields: string[] }
export interface ContractIdl {
  name: string;
  functions: Record<string, IdlEntry>;
  procedures: Record<string, IdlEntry>;
  state?: Field[];        // StateData fields (name + codec type) for field-level state-diff naming
  logStructs?: LogStruct[]; // log-message struct catalog (for contract-log decode in the debugger)
}

const SCALARS = new Set([
  "uint8", "uint16", "uint32", "uint64", "sint8", "sint16", "sint32", "sint64", "bit", "id",
]);

// Collect every `struct <name> ... { <body> }` (brace-matched) into name -> body.
function collectStructs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /struct\s+(\w+)[^{;]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    let depth = 1, i = open + 1;
    for (; i < src.length && depth; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    out.set(m[1], src.slice(open + 1, i - 1));
  }
  return out;
}

// size may be an arithmetic expr (e.g. 64*1024*1024) -> evaluate (digits+arithmetic only, so safe).
const evalN = (s: string): number | null => (/^[0-9*+\-()\s]+$/.test(s.trim()) ? (() => { try { return Function(`return (${s})`)() >>> 0; } catch { return null; } })() : null);

// QPI container metadata (kind + element key/value fmts + capacity) for logical-entry decode, else undefined.
function containerMeta(rawType: string, structs: Map<string, string>): Field["container"] {
  const t = rawType.trim().replace(/^QPI::/, "");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^HashMap\s*<\s*([^,<>]+?)\s*,\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[3]); if (L != null) return { kind: "hashmap", keyFmt: typeToken(m[1], structs), valFmt: typeToken(m[2], structs), capacity: L };
  }
  if ((m = t.match(/^HashSet\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[2]); if (L != null) return { kind: "hashset", keyFmt: typeToken(m[1], structs), capacity: L };
  }
  if ((m = t.match(/^Collection\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {   // pov key is always `id`
    const L = evalN(m[2]); if (L != null) return { kind: "collection", keyFmt: "id", valFmt: typeToken(m[1], structs), capacity: L };
  }
  return undefined;
}

// Map one member type to a codec token.
function typeToken(type: string, structs: Map<string, string>): string {
  type = type.trim().replace(/^QPI::/, "");
  const tt = (x: string) => typeToken(x, structs);
  // QPI containers -> equivalent struct layouts so field offsets/sizes match the C++ StateData (names the
  // field; contents stay raw bytes). Covers scalar/id K/V/T; nested-generic params fall through to raw.
  let m: RegExpMatchArray | null;
  if ((m = type.match(/^HashMap\s*<\s*([^,<>]+?)\s*,\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[3]); if (L != null) return `{ [${L};{ ${tt(m[1])}, ${tt(m[2])} }], [${Math.ceil(L * 2 / 64)};uint64], uint64, uint64 }`;
  }
  if ((m = type.match(/^HashSet\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[2]); if (L != null) return `{ [${L};${tt(m[1])}], [${Math.ceil(L * 2 / 64)};uint64], uint64, uint64 }`;
  }
  if ((m = type.match(/^Collection\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    // PoV{ id value; uint64 population; sint64 head, tail, bstRoot } + flags + Element{ T; sint64 prio,pov,parent,left,right } + 2 counters
    const L = evalN(m[2]); if (L != null) return `{ [${L};{ id, uint64, sint64, sint64, sint64 }], [${Math.ceil(L * 2 / 64)};uint64], [${L};{ ${tt(m[1])}, sint64, sint64, sint64, sint64, sint64 }], uint64, uint64 }`;
  }
  const am = type.match(/^Array\s*<\s*([\s\S]+?)\s*,\s*([^<>]+?)\s*>$/);
  if (am) { const n = evalN(am[2]); return `[${n != null ? n : am[2].trim()};${tt(am[1])}]`; }
  if (SCALARS.has(type)) return type;
  if (type === "m256i") return "m256i"; // raw hex (id is the identity alias, handled by SCALARS)
  if (structs.has(type)) return `{ ${parseFields(structs.get(type)!, structs).join(", ")} }`;
  return type; // unknown — best effort, surfaced verbatim
}

// Parse a struct body into ordered field type tokens.
function parseFields(body: string, structs: Map<string, string>): string[] {
  body = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const toks: string[] = [];
  for (let raw of body.split(";")) {
    raw = raw.trim();
    if (!raw) continue;
    const m = raw.match(/^([\s\S]+?)\s+(\w+)$/);
    if (!m) continue;
    toks.push(typeToken(m[1], structs));
  }
  return toks;
}

function fmtOf(structs: Map<string, string>, structName: string): string {
  const body = structs.get(structName);
  if (body === undefined) return "";
  return parseFields(body, structs).join(", ");
}

// Same as parseFields but keeps the field NAME (for typed codegen).
function fieldsForStruct(structs: Map<string, string>, structName: string): Field[] {
  const body = structs.get(structName);
  if (body === undefined) return [];
  const clean = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Field[] = [];
  for (let raw of clean.split(";")) {
    raw = raw.trim();
    if (!raw) continue;
    const m = raw.match(/^([\s\S]+?)\s+(\w+)$/);
    if (!m) continue;
    out.push({ name: m[2], type: typeToken(m[1], structs), container: containerMeta(m[1], structs) });
  }
  return out;
}

export function extractIdl(source: string, name: string): ContractIdl {
  const structs = collectStructs(source);
  const idl: ContractIdl = { name, functions: {}, procedures: {} };
  for (const m of source.matchAll(/REGISTER_USER_FUNCTION\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/g))
    idl.functions[m[2]] = {
      name: m[1], in: fmtOf(structs, m[1] + "_input"), out: fmtOf(structs, m[1] + "_output"),
      inFields: fieldsForStruct(structs, m[1] + "_input"), outFields: fieldsForStruct(structs, m[1] + "_output"),
    };
  for (const m of source.matchAll(/REGISTER_USER_PROCEDURE\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/g))
    idl.procedures[m[2]] = { name: m[1], in: fmtOf(structs, m[1] + "_input"), inFields: fieldsForStruct(structs, m[1] + "_input") };
  if (structs.has("StateData")) idl.state = fieldsForStruct(structs, "StateData");   // for field-level state diff
  // log-struct catalog: any flat (leaf) struct with a `sint8 _terminator` marker; keep only the fields before it.
  const logStructs: LogStruct[] = [];
  for (const [sname, body] of structs) {
    if (/\bstruct\b/.test(body)) continue;                     // container struct (nested defs) — its leaf children are collected separately
    const fs = fieldsForStruct(structs, sname);
    const ti = fs.findIndex((f) => f.name === "_terminator");
    if (ti <= 0) continue;                                      // not a log struct, or nothing before terminator
    const real = fs.slice(0, ti);
    logStructs.push({ name: sname, fmt: real.map((f) => f.type).join(", "), fields: real.map((f) => f.name) });
  }
  if (logStructs.length) idl.logStructs = logStructs;
  return idl;
}
