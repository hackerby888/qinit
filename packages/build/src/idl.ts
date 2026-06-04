// Extract an IDL from a qpi.h contract .h: REGISTER_USER_* names + _input/_output
// struct layouts -> codec format strings. Output is keyed to match qinit.idl.json
// (consumed by the interactive `/call` picker): { name, functions:{[inputType]:{name,in,out}},
// procedures:{[inputType]:{name,in}} }. Light regex parse — handles flat structs, Array<T,N>,
// nested structs (one+ levels), id; unknown types pass through verbatim.

export interface Field { name: string; type: string } // type = codec token (uint64, id, bytes32, [N;T], { ... })
export interface IdlEntry { name: string; in: string; out?: string; inFields: Field[]; outFields?: Field[] }
export interface ContractIdl {
  name: string;
  functions: Record<string, IdlEntry>;
  procedures: Record<string, IdlEntry>;
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

// Map one member type to a codec token.
function typeToken(type: string, structs: Map<string, string>): string {
  type = type.trim().replace(/^QPI::/, "");
  const am = type.match(/^Array\s*<\s*([\s\S]+)\s*,\s*(\d+)\s*>$/);
  if (am) return `[${am[2]};${typeToken(am[1], structs)}]`;
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
    out.push({ name: m[2], type: typeToken(m[1], structs) });
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
  return idl;
}
