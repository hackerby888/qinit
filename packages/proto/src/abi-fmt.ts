// Contract ABI format-string codec (qubic-cli compatible).
//   types : uint8/16/32/64, sint8/16/32/64, id, bit ; struct { t, t } ; array [N; elem]
//   output format = types only:              "{ [16;id], uint16, uint8 }"
//   input  format = values (carry their type):"ABC…(60-char)id, 5uint64, [2; 1uint64, 2uint64]"
// Little-endian, packed. id <-> 60-char identity via @qinit/core (async, wasm). "" = empty.
import { bytesToIdentity, identityToBytes } from "@qinit/core";

const SCALAR_SIZE: Record<string, number> = {
  uint8: 1, sint8: 1, bit: 1,
  uint16: 2, sint16: 2,
  uint32: 4, sint32: 4,
  uint64: 8, sint64: 8,
};

export type TypeNode =
  | { kind: "scalar"; type: string; size: number; signed: boolean; big: boolean }
  | { kind: "id" }
  | { kind: "array"; count: number; elem: TypeNode }
  | { kind: "struct"; fields: TypeNode[] };

// ---------- type-grammar parser (output layout / decode schema) ----------
function parseType(s: string, i: number): [TypeNode, number] {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === "{") {
    i++;
    const fields: TypeNode[] = [];
    while (true) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (s[i] === "}") { i++; break; }
      const [node, ni] = parseType(s, i); fields.push(node); i = ni;
    }
    return [{ kind: "struct", fields }, i];
  }
  if (s[i] === "[") {
    i++;
    const semi = s.indexOf(";", i);
    const count = parseInt(s.slice(i, semi), 10);
    const [elem, ni] = parseType(s, semi + 1);
    i = ni;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === "]") i++;
    return [{ kind: "array", count, elem }, i];
  }
  let j = i;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  const tok = s.slice(i, j);
  if (tok === "id") return [{ kind: "id" }, j];
  const size = SCALAR_SIZE[tok];
  if (!size) throw new Error(`unknown type '${tok}'`);
  return [{ kind: "scalar", type: tok, size, signed: tok.startsWith("sint"), big: size === 8 }, j];
}

export function parseLayout(fmt: string): TypeNode {
  const t = fmt.trim();
  if (!t) return { kind: "struct", fields: [] };
  const parts = splitTop(t); // top-level list: 1 -> that node; >1 -> implicit struct (symmetric with encode)
  if (parts.length === 1) return parseType(parts[0], 0)[0];
  return { kind: "struct", fields: parts.map((p) => parseType(p, 0)[0]) };
}

// ---------- output decode (async: id -> 60-char identity) ----------
async function decodeNode(v: DataView, off: number, node: TypeNode): Promise<[any, number]> {
  switch (node.kind) {
    case "scalar": {
      let val: number | bigint;
      if (node.big) val = node.signed ? v.getBigInt64(off, true) : v.getBigUint64(off, true);
      else if (node.size === 4) val = node.signed ? v.getInt32(off, true) : v.getUint32(off, true);
      else if (node.size === 2) val = node.signed ? v.getInt16(off, true) : v.getUint16(off, true);
      else val = node.signed ? v.getInt8(off) : v.getUint8(off);
      return [val, off + node.size];
    }
    case "id": {
      const b = new Uint8Array(32);
      for (let k = 0; k < 32; k++) b[k] = v.getUint8(off + k);
      return [await bytesToIdentity(b), off + 32];
    }
    case "array": {
      const arr: any[] = [];
      for (let k = 0; k < node.count; k++) { const [val, no] = await decodeNode(v, off, node.elem); arr.push(val); off = no; }
      return [arr, off];
    }
    case "struct": {
      const obj: any[] = [];
      for (const f of node.fields) { const [val, no] = await decodeNode(v, off, f); obj.push(val); off = no; }
      return [obj, off];
    }
  }
}

export async function decodeOutput(bytes: Uint8Array, fmt: string): Promise<any> {
  const node = parseLayout(fmt);
  const [val] = await decodeNode(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, node);
  return val;
}

// ---------- input encode (value-driven, async for id) ----------
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16);
  return out;
}

// Split by top-level commas, respecting [] and {} nesting.
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter((x) => x.length);
}

// Encode one value token. Scalars carry a type suffix; id by identity (or 64-hex);
// {…}=struct (each field a value token), [N; …]=array (N informational; encode listed elems).
async function encodeToken(tok: string, out: number[]): Promise<void> {
  tok = tok.trim();
  if (!tok) return;
  if (tok[0] === "{") {
    for (const t of splitTop(tok.slice(1, tok.lastIndexOf("}")))) await encodeToken(t, out);
    return;
  }
  if (tok[0] === "[") {
    const inner = tok.slice(1, tok.lastIndexOf("]"));
    const semi = inner.indexOf(";");
    for (const t of splitTop(semi >= 0 ? inner.slice(semi + 1) : inner)) await encodeToken(t, out);
    return;
  }
  if (tok.endsWith("id")) {
    const v = tok.slice(0, -2).trim();
    const b = /^(0x)?[0-9a-fA-F]{64}$/.test(v) ? hexToBytes(v) : identityToBytes(v);
    if (b.length !== 32) throw new Error(`id must resolve to 32 bytes: '${v}'`);
    for (const x of b) out.push(x);
    return;
  }
  const m = tok.match(/^(-?\d+)([a-z0-9]+)$/);
  if (!m) throw new Error(`cannot parse input token '${tok}'`);
  const [, numStr, type] = m;
  const size = SCALAR_SIZE[type];
  if (!size) throw new Error(`unknown input type '${type}'`);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  if (size === 8) dv.setBigUint64(0, BigInt(numStr), true);
  else if (size === 4) dv.setUint32(0, Number(numStr) >>> 0, true);
  else if (size === 2) dv.setUint16(0, Number(numStr) & 0xffff, true);
  else dv.setUint8(0, Number(numStr) & 0xff);
  for (const x of buf) out.push(x);
}

// Top-level value tokens (comma-separated). "" = empty input.
export async function encodeInput(fmt: string): Promise<Uint8Array> {
  const t = (fmt ?? "").trim();
  if (!t) return new Uint8Array(0);
  const out: number[] = [];
  for (const tok of splitTop(t)) await encodeToken(tok, out);
  return new Uint8Array(out);
}
