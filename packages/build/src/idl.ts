// Extract registered entries and struct layouts from a qpi.h contract into qinit.idl.json format.

// QPI container layouts come from @qinit/proto qpi-layout (single source of truth shared with the decoders).
import { hashMapFmt, hashSetFmt, collectionFmt } from "@qinit/proto/qpi-layout";

// `type` is the codec token; `container`, `struct`, and `array` retain richer decode/codegen metadata.
export interface Field {
  name: string;
  type: string;
  container?: {
    kind: "hashmap" | "hashset" | "collection";
    keyFmt: string;
    valFmt?: string;
    capacity: number;
  };
  struct?: Field[];
  array?: boolean;
}
export interface IdlEntry {
  name: string;
  in: string;
  out?: string;
  inFields: Field[];
  outFields?: Field[];
}
// A qpi LOG_* struct (ends with `sint8 _terminator`): fmt/fields cover only the members BEFORE the terminator
// (what the node logs). The decoder size-matches a log's byte count against these. fmt = comma-joined types.
export interface LogStruct {
  name: string;
  fmt: string;
  fields: string[];
}
// A C++ enum -> { value: memberName } (value stringified). Used to resolve a log's `_type` discriminator to a name.
export interface EnumDef {
  name: string;
  members: Record<string, string>;
  base?: string;
}
export interface ContractIdl {
  name: string;
  functions: Record<string, IdlEntry>;
  procedures: Record<string, IdlEntry>;
  state?: Field[]; // StateData fields (name + codec type) for field-level state-diff naming
  logStructs?: LogStruct[]; // log-message struct catalog (for contract-log decode in the debugger)
  enums?: EnumDef[]; // enums (e.g. log message kinds) -> name the `_type` discriminator
  migrate?: boolean; // contract declares MIGRATE() -> a redeploy with matching OldStateData runs __migrate
  oldState?: Field[]; // OldStateData fields (the prior StateData layout the migration reads from)
}

const SCALARS = new Set([
  "uint8", "uint16", "uint32", "uint64", "sint8", "sint16", "sint32", "sint64", "bit", "id",
]);

// Blank out comments (length-preserving: keep newlines + offsets) so the struct/enum/typedef scanners never
// match a keyword that appears inside a comment — e.g. `// gov struct` immediately before `struct QtryGOV {`
function blankComments(src: string): string {
  return src
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// Collect every `struct <name> ... { <body> }` (brace-matched) into name -> body. Nested structs are also
// stored under every scoped-name suffix (e.g. Parent::Order) so scope-resolved field types resolve.
function collectStructs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /struct\s+(\w+)[^{;]*\{/g;
  const all: { name: string; open: number; close: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    let depth = 1;
    let i = open + 1;
    for (; i < src.length && depth; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
    all.push({ name: m[1], open, close: i - 1 });
  }
  const bareDepth = new Map<string, number>();
  for (const s of all) {
    const body = src.slice(s.open + 1, s.close);
    const parents = all
      .filter((parent) => parent.open < s.open && parent.close > s.close)
      .sort((a, b) => a.open - b.open)
      .map((parent) => parent.name);
    // bare name resolves to the SHALLOWEST struct (e.g. the contract-level `Order` a StateData field references),
    // not the last-declared — a deeper function-nested struct of the same name must not shadow it.
    if (!bareDepth.has(s.name) || parents.length < bareDepth.get(s.name)!) {
      out.set(s.name, body);
      bareDepth.set(s.name, parents.length);
    }
    for (let k = 0; k < parents.length; k++) {
      out.set([...parents.slice(k), s.name].join("::"), body);
    }
  }
  return out;
}

// constexpr constants (name -> value) resolved from the contract source, so array/container sizes that use a
// named constant (e.g. QEARN's Array<RoundInfo, QEARN_MAX_EPOCHS>) evaluate. Set per extractIdl().
let g_consts = new Map<string, number>();
let g_enums = new Map<string, string>(); // enum name -> underlying codec type — set per extractIdl()
let g_typedefs = new Map<string, string>(); // typedef/using alias -> target type — set per extractIdl()
// `typedef <target> <name>;` and `using <name> = <target>;` (skip function-pointer/template-heavy ones).
function collectTypedefs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/typedef\s+([\w:][\w:<>,\s*&]*?)\s+(\w+)\s*;/g)) {
    if (!m[1].includes("(")) out.set(m[2], m[1].trim());
  }
  for (const m of src.matchAll(/using\s+(\w+)\s*=\s*([^;]+);/g)) {
    if (!m[2].includes("(")) out.set(m[1], m[2].trim());
  }
  return out;
}
// Normalize a size expression: strip int suffixes + rewrite QPI div/mul/mod<T>(a,b) helpers to arithmetic.
function normalizeExpr(e: string): string {
  e = e.replace(/(\d)[uUlL]+/g, "$1");
  let prev = "";
  while (prev !== e) {
    prev = e;
    e = e
      .replace(/\bdiv(?:\s*<[^>]*>)?\s*\(([^()]+?),([^()]+?)\)/g, "Math.trunc(($1)/($2))")
      .replace(/\bmul(?:\s*<[^>]*>)?\s*\(([^()]+?),([^()]+?)\)/g, "(($1)*($2))")
      .replace(/\bmod(?:\s*<[^>]*>)?\s*\(([^()]+?),([^()]+?)\)/g, "(($1)%($2))");
  }
  return e;
}
// Eval an arithmetic size expr (digits, operators, Math.trunc only — safe). null if any identifier is unresolved.
function evalExpr(e: string): number | null {
  if (!/^(?:Math\.trunc|[0-9*/%+\-()\s.])+$/.test(e.trim())) return null;
  try {
    return Math.trunc(Function(`return (${e})`)());
  } catch {
    return null;
  }
}
const subst = (e: string, m: Map<string, number>) =>
  e.replace(/[A-Za-z_]\w*/g, (id) => (m.has(id) ? String(m.get(id)) : id));
function collectConsts(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /constexpr\s+(?:unsigned\s+|signed\s+)?[\w:]+\s+(\w+)\s*=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const v = evalExpr(normalizeExpr(subst(m[2], out)));
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
  const re = /enum\s+(?:class\s+|struct\s+)?(\w+)\s*(?::\s*([\w: ]+?)\s*)?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const body = m[3].replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const members: Record<string, string> = {};
    let next = 0;
    for (const part of body.split(",")) {
      const mm = part.trim().match(/^(\w+)\s*(?:=\s*(.+))?$/);
      if (!mm) continue;
      let val = next;
      if (mm[2] !== undefined) {
        const explicitValue = evalN(mm[2]);
        if (explicitValue != null) val = explicitValue;
      }
      members[String(val)] = mm[1];
      next = val + 1;
    }
    if (Object.keys(members).length) out.push({ name: m[1], members, base: m[2]?.trim() });
  }
  return out;
}

// underlying type of an enum -> codec type (default C++ int = uint32). `enum class X : uint8` -> uint8 (1 byte).
function enumType(base?: string): string {
  if (!base) return "uint32";
  const b = base.replace(/^QPI::/, "").replace(/\s+/g, " ");
  if (SCALARS.has(b) || b === "uint128" || b === "sint128") return b;
  return NATIVE[b] ?? "uint32";
}

// QPI container metadata (kind + element key/value fmts + capacity) for logical-entry decode, else undefined.
function containerMeta(rawType: string, structs: Map<string, string>, scope?: string): Field["container"] {
  const t = rawType.trim().replace(/^QPI::/, "");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^HashMap\s*<\s*([^,<>]+?)\s*,\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const capacity = evalN(m[3]);
    if (capacity != null) {
      return {
        kind: "hashmap",
        keyFmt: typeToken(m[1], structs, scope),
        valFmt: typeToken(m[2], structs, scope),
        capacity,
      };
    }
  }
  if ((m = t.match(/^HashSet\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const capacity = evalN(m[2]);
    if (capacity != null) {
      return { kind: "hashset", keyFmt: typeToken(m[1], structs, scope), capacity };
    }
  }
  if ((m = t.match(/^Collection\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {   // pov key is always `id`
    const capacity = evalN(m[2]);
    if (capacity != null) {
      return {
        kind: "collection",
        keyFmt: "id",
        valFmt: typeToken(m[1], structs, scope),
        capacity,
      };
    }
  }
  return undefined;
}

// C++ native types -> sized QPI codec types (QX/QEARN message structs use a few of these).
const NATIVE: Record<string, string> = {
  "unsigned char": "uint8",
  "unsigned short": "uint16",
  "unsigned int": "uint32",
  "unsigned": "uint32",
  "unsigned long": "uint64",
  "unsigned long long": "uint64",
  "char": "sint8",
  "signed char": "sint8",
  "short": "sint16",
  "int": "sint32",
  "long": "sint64",
  "long long": "sint64",
  "bool": "uint8",
};

// Resolve a (possibly bare) struct name to the key in `structs`, preferring a name SCOPED to the current struct
// (Parent::Child) over the bare name, so nested types resolve in their declaring scope.
function resolveStructName(name: string, structs: Map<string, string>, scope?: string): string | null {
  name = name.trim();
  if (scope) {
    const segs = scope.split("::");
    for (let k = segs.length; k >= 1; k--) {
      const cand = [...segs.slice(0, k), name].join("::");
      if (structs.has(cand)) return cand;
    }
  }
  if (structs.has(name)) return name;
  // For qualified references, try each trailing suffix longest-first before the bare name.
  if (name.includes("::")) {
    const segs = name.split("::");
    for (let k = 1; k < segs.length; k++) {
      const cand = segs.slice(k).join("::");
      if (structs.has(cand)) return cand;
    }
  }
  return null;
}

// Remove nested type DEFINITIONS (`struct/union/class/enum Name { ... };`) from a struct body, brace-matched, so
// they are not mis-parsed as fields (a nested `struct Order {...};` would otherwise leak a junk `Order` field).
function stripNestedDefs(body: string): string {
  let out = body;
  for (;;) {
    const m = out.match(/\b(?:struct|union|class|enum)\b[^{};]*\{/);
    if (!m) return out;
    const open = m.index! + m[0].length - 1;
    let depth = 1;
    let i = open + 1;
    for (; i < out.length && depth; i++) {
      if (out[i] === "{") depth++;
      else if (out[i] === "}") depth--;
    }
    while (i < out.length && out[i] !== ";") i++; // eat any trailing var-list up to the terminator
    out = out.slice(0, m.index!) + " " + out.slice(i + 1);
  }
}

// Map one member type to a codec token.
function typeToken(type: string, structs: Map<string, string>, scope?: string): string {
  type = type.trim().replace(/^QPI::/, "").replace(/\s+/g, " ");
  if (NATIVE[type]) return NATIVE[type];
  const toTypeToken = (value: string) => typeToken(value, structs, scope);
  // QPI containers use equivalent struct layouts so field offsets and sizes match C++ StateData.
  let m: RegExpMatchArray | null;
  if ((m = type.match(/^HashMap\s*<\s*([^,<>]+?)\s*,\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const capacity = evalN(m[3]);
    if (capacity != null) return hashMapFmt(toTypeToken(m[1]), toTypeToken(m[2]), capacity);
  }
  if ((m = type.match(/^HashSet\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const capacity = evalN(m[2]);
    if (capacity != null) return hashSetFmt(toTypeToken(m[1]), capacity);
  }
  if ((m = type.match(/^Collection\s*<\s*([^,<>]+?)\s*,\s*([^<>]+?)\s*>$/))) {
    const capacity = evalN(m[2]);
    if (capacity != null) return collectionFmt(toTypeToken(m[1]), capacity);
  }
  const am = type.match(/^Array\s*<\s*([\s\S]+?)\s*,\s*([^<>]+?)\s*>$/);
  if (am) {
    const length = evalN(am[2]);
    return `[${length != null ? length : am[2].trim()};${toTypeToken(am[1])}]`;
  }
  if (SCALARS.has(type)) return type;
  if (type === "m256i" || type === "uint128" || type === "sint128") return type;
  if (type === "Asset") return "{ id, uint64 }";
  if (type === "DateAndTime") return "uint64";
  if (type === "bit_4096") return "[64; uint64]";
  const bitArrayMatch = type.match(/^BitArray\s*<\s*([^<>]+?)\s*>$/);
  if (bitArrayMatch) {
    const bitCount = evalN(bitArrayMatch[1]);
    if (bitCount != null) return `[${Math.ceil(bitCount / 64)}; uint64]`;
  }
  if (g_enums.has(type)) return g_enums.get(type)!;
  if (g_typedefs.has(type)) return typeToken(g_typedefs.get(type)!, structs);
  // Resolve exact/scoped names before falling back to the original type.
  const sname = resolveStructName(type, structs, scope);
  if (sname) return `{ ${parseFields(structs.get(sname)!, structs, sname).join(", ")} }`;
  return type; // unknown — best effort, surfaced verbatim
}

// Strip member-function bodies ({...}, innermost-first) so a StateData with methods parses to fields only.
function stripMethods(body: string): string {
  let prev: string;
  do {
    prev = body;
    body = body.replace(/\{[^{}]*\}/g, " ");
  } while (body !== prev);
  return body;
}

// Strip comments, nested type definitions, then method bodies — leaving only the struct's data members.
function memberBody(body: string): string {
  return stripMethods(stripNestedDefs(body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")));
}
const isTypeDef = (raw: string) => /^(?:struct|union|class|enum)\b/.test(raw);

// Parse ordered fields once for both flat codec formats and typed field trees.
function parseMembers(body: string, structs: Map<string, string>, scope: string, depth: number): Field[] {
  const out: Field[] = [];
  for (let raw of memberBody(body).split(";")) {
    raw = raw.trim();
    if (!raw || raw.includes("(") || isTypeDef(raw)) continue;   // skip method sigs + nested type defs
    // multi-var: "type a, b, c" (simple types only — template types like Collection<A,B> carry commas)
    const mv = raw.match(/^([A-Za-z_][\w:\s*]*?)\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)$/);
    if (mv && !mv[1].includes("<")) {
      const ty = mv[1].trim();
      const type = typeToken(ty, structs, scope);
      const container = containerMeta(ty, structs, scope);
      const detail = fieldDetail(ty, structs, scope, depth);
      for (const name of mv[2].split(",")) {
        out.push({ name: name.trim(), type, container, ...detail });
      }
      continue;
    }
    const m = raw.match(/^([\s\S]+?)\s+(\w+)$/);
    if (!m) continue;
    out.push({
      name: m[2],
      type: typeToken(m[1], structs, scope),
      container: containerMeta(m[1], structs, scope),
      ...fieldDetail(m[1], structs, scope, depth),
    });
  }
  return out;
}

// The flat codec format-string tokens of a struct body — derived from the same member parse as the typed tree.
function parseFields(body: string, structs: Map<string, string>, scope = ""): string[] {
  return parseMembers(body, structs, scope, 0).map((f) => f.type);
}

function fmtOf(structs: Map<string, string>, structName: string): string {
  const body = structs.get(structName);
  if (body === undefined) return "";
  return parseFields(body, structs, structName).join(", ");
}

// Resolve a member's nested shape for typed codegen: its struct member fields (recursively) + whether it is an
// Array<...>. Returns {} for scalars/ids/containers — the flat `type` token already describes those.
function fieldDetail(
  rawType: string,
  structs: Map<string, string>,
  scope: string,
  depth: number,
): { struct?: Field[]; array?: boolean } {
  if (depth > 16) return {};
  let t = rawType.trim().replace(/^QPI::/, "");
  if (g_typedefs.has(t)) t = g_typedefs.get(t)!.trim();
  const am = t.match(/^Array\s*<\s*([\s\S]+?)\s*,\s*([^<>]+?)\s*>$/);
  if (am) {
    const inner = fieldDetail(am[1].trim(), structs, scope, depth + 1);
    return inner.struct ? { struct: inner.struct, array: true } : { array: true };
  }
  if (t === "Asset") {
    return {
      struct: [
        { name: "issuer", type: "id" },
        { name: "assetName", type: "uint64" },
      ],
    };
  }
  const sname = resolveStructName(t, structs, scope);
  if (sname) return { struct: fieldsForStruct(structs, sname, sname, depth + 1) };
  return {};
}

// Like parseFields but keyed by struct NAME, returning the full named field tree (for typed codegen).
function fieldsForStruct(
  structs: Map<string, string>,
  structName: string,
  scope = structName,
  depth = 0,
): Field[] {
  const body = structs.get(structName);
  return body === undefined ? [] : parseMembers(body, structs, scope, depth);
}

// `opts.prelude` supplies ambient definitions that the contract uses without including directly.
export function extractIdl(source: string, name: string, opts?: { prelude?: string }): ContractIdl {
  const src = blankComments(source);
  const symbols = opts?.prelude ? blankComments(opts.prelude) + "\n" + src : src;
  g_consts = collectConsts(symbols);
  g_enums = new Map(collectEnums(symbols).map((e) => [e.name, enumType(e.base)]));
  g_typedefs = collectTypedefs(symbols);
  const structs = collectStructs(symbols);
  const idl: ContractIdl = { name, functions: {}, procedures: {} };
  for (const m of src.matchAll(/REGISTER_USER_FUNCTION\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/g)) {
    idl.functions[m[2]] = {
      name: m[1],
      in: fmtOf(structs, m[1] + "_input"),
      out: fmtOf(structs, m[1] + "_output"),
      inFields: fieldsForStruct(structs, m[1] + "_input"),
      outFields: fieldsForStruct(structs, m[1] + "_output"),
    };
  }
  for (const m of src.matchAll(/REGISTER_USER_PROCEDURE\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/g)) {
    idl.procedures[m[2]] = {
      name: m[1],
      in: fmtOf(structs, m[1] + "_input"),
      out: fmtOf(structs, m[1] + "_output"),
      inFields: fieldsForStruct(structs, m[1] + "_input"),
      outFields: fieldsForStruct(structs, m[1] + "_output"),
    };
  }
  if (structs.has("StateData")) idl.state = fieldsForStruct(structs, "StateData");
  if (/\bMIGRATE(?:_WITH_LOCALS)?\s*\(\s*\)/.test(src)) {
    idl.migrate = true;
    if (structs.has("OldStateData")) idl.oldState = fieldsForStruct(structs, "OldStateData");
  }
  // log-struct catalog: any flat (leaf) struct with a `sint8 _terminator` marker; keep only the fields before it.
  const logStructs: LogStruct[] = [];
  for (const [sname, body] of structs) {
    if (sname.includes("::")) continue;
    if (/\bstruct\b/.test(body)) continue;
    const fs = fieldsForStruct(structs, sname);
    const ti = fs.findIndex((f) => f.name === "_terminator");
    if (ti <= 0) continue;
    const real = fs.slice(0, ti);
    logStructs.push({
      name: sname,
      fmt: real.map((f) => f.type).join(", "),
      fields: real.map((f) => f.name),
    });
  }
  if (logStructs.length) idl.logStructs = logStructs;
  const enums = collectEnums(src);
  if (enums.length) idl.enums = enums;
  return idl;
}
