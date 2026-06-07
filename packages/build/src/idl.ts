// Extract an IDL from a qpi.h contract .h: REGISTER_USER_* names + _input/_output
// struct layouts -> codec format strings. Output is keyed to match qinit.idl.json
// (consumed by the interactive `/call` picker): { name, functions:{[inputType]:{name,in,out}},
// procedures:{[inputType]:{name,in}} }. Light regex parse — handles flat structs, Array<T,N>,
// nested structs (one+ levels), id; unknown types pass through verbatim.

// QPI container layouts come from @qinit/proto qpi-layout (single source of truth shared with the decoders).
import { hashMapFmt, hashSetFmt, collectionFmt } from "@qinit/proto";

// type = codec token (uint64, id, bytes32, [N;T], { ... }); container = QPI HashMap/HashSet meta (for logical decode)
export interface Field { name: string; type: string; container?: { kind: "hashmap" | "hashset" | "collection"; keyFmt: string; valFmt?: string; capacity: number } }
export interface IdlEntry { name: string; in: string; out?: string; inFields: Field[]; outFields?: Field[] }
// A qpi LOG_* struct (ends with `sint8 _terminator`): fmt/fields cover only the members BEFORE the terminator
// (what the node logs). The decoder size-matches a log's byte count against these. fmt = comma-joined types.
export interface LogStruct { name: string; fmt: string; fields: string[] }
// A C++ enum -> { value: memberName } (value stringified). Used to resolve a log's `_type` discriminator to a name.
export interface EnumDef { name: string; members: Record<string, string> }
export interface ContractIdl {
  name: string;
  functions: Record<string, IdlEntry>;
  procedures: Record<string, IdlEntry>;
  state?: Field[];        // StateData fields (name + codec type) for field-level state-diff naming
  logStructs?: LogStruct[]; // log-message struct catalog (for contract-log decode in the debugger)
  enums?: EnumDef[];      // enums (e.g. log message kinds) -> name the `_type` discriminator
}

const SCALARS = new Set([
  "uint8", "uint16", "uint32", "uint64", "sint8", "sint16", "sint32", "sint64", "bit", "id",
]);

// Collect every `struct <name> ... { <body> }` (brace-matched) into name -> body. Nested structs are also
// stored under every scoped-name suffix (e.g. Parent::Order) so scope-resolved field types resolve.
function collectStructs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /struct\s+(\w+)[^{;]*\{/g;
  const all: { name: string; open: number; close: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    let depth = 1, i = open + 1;
    for (; i < src.length && depth; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    all.push({ name: m[1], open, close: i - 1 });
  }
  for (const s of all) {
    const body = src.slice(s.open + 1, s.close);
    out.set(s.name, body);   // bare name (last-declared wins on collision — the scoped keys below disambiguate)
    const parents = all.filter((p) => p.open < s.open && p.close > s.close).sort((a, b) => a.open - b.open).map((p) => p.name);
    for (let k = 0; k < parents.length; k++) out.set([...parents.slice(k), s.name].join("::"), body);   // every scoped suffix
  }
  return out;
}

// constexpr constants (name -> value) resolved from the contract source, so array/container sizes that use a
// named constant (e.g. QEARN's Array<RoundInfo, QEARN_MAX_EPOCHS>) evaluate. Set per extractIdl().
let g_consts = new Map<string, number>();
let g_enums = new Set<string>();   // enum type names (sized as their underlying int) — set per extractIdl()
// Normalize a size expression: strip int suffixes + rewrite QPI div/mul/mod<T>(a,b) helpers to arithmetic.
function normalizeExpr(e: string): string {
  e = e.replace(/(\d)[uUlL]+/g, "$1");
  let prev = "";
  while (prev !== e) {
    prev = e;
    e = e.replace(/\bdiv\s*<[^>]*>\s*\(([^()]+?),([^()]+?)\)/g, "Math.trunc(($1)/($2))")
         .replace(/\bmul\s*<[^>]*>\s*\(([^()]+?),([^()]+?)\)/g, "(($1)*($2))")
         .replace(/\bmod\s*<[^>]*>\s*\(([^()]+?),([^()]+?)\)/g, "(($1)%($2))");
  }
  return e;
}
// Eval an arithmetic size expr (digits, operators, Math.trunc only — safe). null if any identifier is unresolved.
function evalExpr(e: string): number | null {
  if (!/^(?:Math\.trunc|[0-9*/%+\-()\s.])+$/.test(e.trim())) return null;
  try { return Math.trunc(Function(`return (${e})`)()); } catch { return null; }
}
const subst = (e: string, m: Map<string, number>) => e.replace(/[A-Za-z_]\w*/g, (id) => (m.has(id) ? String(m.get(id)) : id));
function collectConsts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /constexpr\s+(?:unsigned\s+|signed\s+)?[\w:]+\s+(\w+)\s*=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const v = evalExpr(normalizeExpr(subst(m[2], out)));   // substitute prior consts, then rewrite div<>()/suffixes
    if (v != null) out.set(m[1], v);
  }
  return out;
}

// size may be an arithmetic expr (e.g. 64*1024*1024), a constexpr name (QEARN_MAX_EPOCHS), or a div<>() helper.
const evalN = (s: string): number | null => {
  const v = evalExpr(normalizeExpr(subst(s, g_consts)));
  return v == null ? null : v >>> 0;
};

// Collect every `enum [class] Name [: base] { A=0, B, ... }` into name -> { value: member } (C++ auto-increment).
function collectEnums(src: string): EnumDef[] {
  const out: EnumDef[] = [];
  const re = /enum\s+(?:class\s+|struct\s+)?(\w+)\s*(?::\s*\w+\s*)?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[2].replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const members: Record<string, string> = {};
    let next = 0;
    for (const part of body.split(",")) {
      const mm = part.trim().match(/^(\w+)\s*(?:=\s*(.+))?$/);
      if (!mm) continue;
      let val = next;
      if (mm[2] !== undefined) { const ev = evalN(mm[2]); if (ev != null) val = ev; }
      members[String(val)] = mm[1];
      next = val + 1;
    }
    if (Object.keys(members).length) out.push({ name: m[1], members });
  }
  return out;
}

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

// C++ native types -> sized QPI codec types (QX/QEARN message structs use a few of these).
const NATIVE: Record<string, string> = {
  "unsigned char": "uint8", "unsigned short": "uint16", "unsigned int": "uint32", "unsigned": "uint32",
  "unsigned long": "uint64", "unsigned long long": "uint64",
  "char": "sint8", "signed char": "sint8", "short": "sint16", "int": "sint32",
  "long": "sint64", "long long": "sint64", "bool": "uint8",
};

// Map one member type to a codec token.
function typeToken(type: string, structs: Map<string, string>): string {
  type = type.trim().replace(/^QPI::/, "").replace(/\s+/g, " ");
  if (NATIVE[type]) return NATIVE[type];
  const tt = (x: string) => typeToken(x, structs);
  // QPI containers -> equivalent struct layouts so field offsets/sizes match the C++ StateData (names the
  // field; contents stay raw bytes). Covers scalar/id K/V/T; nested-generic params fall through to raw.
  let m: RegExpMatchArray | null;
  if ((m = type.match(/^HashMap\s*<\s*([^,<>]+?)\s*,\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[3]); if (L != null) return hashMapFmt(tt(m[1]), tt(m[2]), L);
  }
  if ((m = type.match(/^HashSet\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[2]); if (L != null) return hashSetFmt(tt(m[1]), L);
  }
  if ((m = type.match(/^Collection\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const L = evalN(m[2]); if (L != null) return collectionFmt(tt(m[1]), L);
  }
  const am = type.match(/^Array\s*<\s*([\s\S]+?)\s*,\s*([^<>]+?)\s*>$/);
  if (am) { const n = evalN(am[2]); return `[${n != null ? n : am[2].trim()};${tt(am[1])}]`; }
  if (SCALARS.has(type)) return type;
  if (type === "m256i" || type === "uint128" || type === "sint128") return type;   // raw-hex / 128-bit (abi-fmt sizes them)
  if (type === "Asset") return "{ id, uint64 }";   // QPI built-in: { id issuer; uint64 assetName }
  if (g_enums.has(type)) return "uint32";   // C++ enum -> underlying int (4 bytes)
  // resolve a struct by exact (incl. scoped Parent::Child) name, else the bare last segment of a scoped type
  const sname = structs.has(type) ? type : type.includes("::") && structs.has(type.split("::").pop()!) ? type.split("::").pop()! : null;
  if (sname) return `{ ${parseFields(structs.get(sname)!, structs).join(", ")} }`;
  return type; // unknown — best effort, surfaced verbatim
}

// Strip member-function bodies ({...}, innermost-first) so a StateData with methods parses to fields only.
function stripMethods(body: string): string {
  let prev: string;
  do { prev = body; body = body.replace(/\{[^{}]*\}/g, " "); } while (body !== prev);
  return body;
}

// Parse a struct body into ordered field type tokens.
function parseFields(body: string, structs: Map<string, string>): string[] {
  body = stripMethods(body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""));
  const toks: string[] = [];
  for (let raw of body.split(";")) {
    raw = raw.trim();
    if (!raw || raw.includes("(")) continue;   // skip leftover method signatures
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
  const clean = stripMethods(body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""));
  const out: Field[] = [];
  for (let raw of clean.split(";")) {
    raw = raw.trim();
    if (!raw || raw.includes("(")) continue;   // skip leftover method signatures
    // multi-var: "type a, b, c" (simple types only — template types like Collection<A,B> carry commas)
    const mv = raw.match(/^([A-Za-z_][\w:\s*]*?)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)$/);
    if (mv && !mv[1].includes("<")) {
      const ty = mv[1].trim();
      for (const nm of mv[2].split(",")) out.push({ name: nm.trim(), type: typeToken(ty, structs), container: containerMeta(ty, structs) });
      continue;
    }
    const m = raw.match(/^([\s\S]+?)\s+(\w+)$/);
    if (!m) continue;
    out.push({ name: m[2], type: typeToken(m[1], structs), container: containerMeta(m[1], structs) });
  }
  return out;
}

export function extractIdl(source: string, name: string): ContractIdl {
  g_consts = collectConsts(source);   // resolve constexpr sizes before parsing struct/array layouts
  g_enums = new Set(collectEnums(source).map((e) => e.name));   // enum-typed fields size as their underlying int
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
    if (sname.includes("::")) continue;                        // scoped-name alias of a struct already visited by its bare name
    if (/\bstruct\b/.test(body)) continue;                     // container struct (nested defs) — its leaf children are collected separately
    const fs = fieldsForStruct(structs, sname);
    const ti = fs.findIndex((f) => f.name === "_terminator");
    if (ti <= 0) continue;                                      // not a log struct, or nothing before terminator
    const real = fs.slice(0, ti);
    logStructs.push({ name: sname, fmt: real.map((f) => f.type).join(", "), fields: real.map((f) => f.name) });
  }
  if (logStructs.length) idl.logStructs = logStructs;
  const enums = collectEnums(source);
  if (enums.length) idl.enums = enums;
  return idl;
}
