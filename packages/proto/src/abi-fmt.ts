// Contract ABI format-string codec (qubic-cli compatible).
//   types : uint8/16/32/64, sint8/16/32/64, id, bit ; struct { t, t } ; array [N; elem]
import { bytesToIdentity, identityToBytes, roundUp } from "@qinit/core";
import {
  AbiScalarKind,
  AbiTypeKind,
  formatAbiType,
  type AbiStruct,
  type AbiType,
} from "./contract-idl";
import { flagWordCount } from "./qpi-layout";

const SCALAR_SIZE: Record<string, number> = {
  uint8: 1,
  sint8: 1,
  bit: 1,
  uint16: 2,
  sint16: 2,
  uint32: 4,
  sint32: 4,
  uint64: 8,
  sint64: 8,
};

export type TypeNode =
  | { kind: "scalar"; type: string; size: number; signed: boolean; big: boolean }
  | { kind: "uint128" }
  | { kind: "id" }
  | { kind: "bytes"; size: number } // m256i as raw hex (a digest, NOT an identity)
  | { kind: "array"; count: number; elem: TypeNode }
  | { kind: "struct"; fields: TypeNode[] };

function alignOf(n: TypeNode): number {
  switch (n.kind) {
    case "scalar":
      return n.size; // 1/2/4/8
    case "uint128":
      return 8; // uint128_t = { uint64 low; uint64 high; }
    case "id":
      return 8; // m256i = 4x uint64 -> align 8
    case "bytes":
      return n.size >= 8 ? 8 : 1; // bytes32 (m256i) -> align 8
    case "array":
      return alignOf(n.elem);
    case "struct":
      return n.fields.length ? Math.max(...n.fields.map(alignOf)) : 1;
  }
}

function sizeOf(n: TypeNode): number {
  switch (n.kind) {
    case "scalar":
      return n.size;
    case "uint128":
      return 16;
    case "id":
      return 32; // identity = 32 bytes on the wire
    case "bytes":
      return n.size;
    case "array":
      return n.count * roundUp(sizeOf(n.elem), alignOf(n.elem)); // padded element stride
    case "struct": {
      let o = 0;
      for (const f of n.fields) {
        o = roundUp(o, alignOf(f));
        o += sizeOf(f);
      }
      return n.fields.length ? roundUp(o, alignOf(n)) : 1;
    }
  }
}

// Byte offset + size of each top-level field of a layout (matches the decode/struct alignment). Used to map
// a changed state byte offset back to a field name (the debugger's field-level state diff).
export function structFieldOffsets(
  fmt: string | AbiStruct,
): { off: number; size: number }[] {
  if (typeof fmt !== "string") {
    return fmt.fields.map((field) => ({
      off: field.offset,
      size: field.size,
    }));
  }
  const node = parseLayout(fmt);
  const fields = node.kind === "struct" ? node.fields : [node];
  const out: { off: number; size: number }[] = [];
  let off = 0;
  for (const f of fields) {
    off = roundUp(off, alignOf(f));
    out.push({ off, size: sizeOf(f) });
    off += sizeOf(f);
  }
  return out;
}

// Total size + alignment of a layout (the C++ array stride of a T is roundUp(size, align)). For container decode.
export function layoutOf(fmt: string | AbiType): { size: number; align: number } {
  if (typeof fmt !== "string") {
    return {
      size: fmt.size,
      align: fmt.align,
    };
  }
  const n = parseLayout(fmt);
  return { size: sizeOf(n), align: alignOf(n) };
}

function nodeOf(type: AbiType): TypeNode {
  if (type.kind === AbiTypeKind.STRUCT) {
    return {
      kind: "struct",
      fields: type.fields.map((field) => nodeOf(field.type)),
    };
  }
  if (type.kind === AbiTypeKind.ARRAY) {
    return {
      kind: "array",
      count: type.count,
      elem: nodeOf(type.element),
    };
  }
  return parseLayout(formatAbiType(type));
}

// ---------- type-grammar parser (output layout / decode schema) ----------
function parseType(s: string, i: number): [TypeNode, number] {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === "{") {
    i++;
    const fields: TypeNode[] = [];
    while (true) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (s[i] === "}") {
        i++;
        break;
      }
      const [node, ni] = parseType(s, i);
      fields.push(node);
      i = ni;
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
  if (tok === "m256i") return [{ kind: "bytes", size: 32 }, j]; // m256i raw hex (vs id = identity)
  if (tok === "uint128") return [{ kind: "uint128" }, j];
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

// ---------- output decode (aligned; async: id -> 60-char identity) ----------
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
    case "uint128": {
      const low = v.getBigUint64(off, true);
      const high = v.getBigUint64(off + 8, true);
      return [(high << 64n) | low, off + 16];
    }
    case "id": {
      const b = new Uint8Array(32);
      for (let k = 0; k < 32; k++) b[k] = v.getUint8(off + k);
      return [await bytesToIdentity(b), off + 32];
    }
    case "bytes": {
      let h = "";
      for (let k = 0; k < node.size; k++)
        h += v
          .getUint8(off + k)
          .toString(16)
          .padStart(2, "0");
      return [h, off + node.size];
    }
    case "array": {
      const arr: any[] = [];
      const ea = alignOf(node.elem);
      for (let k = 0; k < node.count; k++) {
        off = roundUp(off, ea);
        const [val, no] = await decodeNode(v, off, node.elem);
        arr.push(val);
        off = no;
      }
      return [arr, off];
    }
    case "struct": {
      if (node.fields.length === 0) {
        v.getUint8(off);
        return [[], off + 1];
      }
      const obj: any[] = [];
      for (const f of node.fields) {
        off = roundUp(off, alignOf(f));
        const [val, no] = await decodeNode(v, off, f);
        obj.push(val);
        off = no;
      }
      return [obj, roundUp(off, alignOf(node))];
    }
  }
}

async function decodeAbiType(
  view: DataView,
  offset: number,
  type: AbiType,
): Promise<any> {
  assertBounds(view, offset, type.size);

  switch (type.kind) {
    case AbiTypeKind.SCALAR:
      return decodeAbiScalar(view, offset, type.scalar);
    case AbiTypeKind.STRUCT:
      return await Promise.all(
        type.fields.map((field) =>
          decodeAbiType(view, offset + field.offset, field.type),
        ),
      );
    case AbiTypeKind.ARRAY: {
      const stride = roundUp(type.element.size, type.element.align);
      const values: any[] = [];
      for (let index = 0; index < type.count; index++) {
        values.push(
          await decodeAbiType(view, offset + index * stride, type.element),
        );
      }
      return values;
    }
    case AbiTypeKind.HASH_MAP:
      return await decodeAbiHashMap(view, offset, type);
    case AbiTypeKind.HASH_SET:
      return await decodeAbiHashSet(view, offset, type);
    case AbiTypeKind.COLLECTION:
      return await decodeAbiCollection(view, offset, type);
  }
}

async function decodeAbiHashMap(
  view: DataView,
  offset: number,
  type: Extract<AbiType, { kind: AbiTypeKind.HASH_MAP }>,
): Promise<any[]> {
  const elementAlign = Math.max(type.key.align, type.value.align);
  const valueOffset = roundUp(type.key.size, type.value.align);
  const elementStride = roundUp(
    valueOffset + type.value.size,
    elementAlign,
  );
  const elements: any[] = [];
  for (let index = 0; index < type.capacity; index++) {
    const elementOffset = offset + index * elementStride;
    elements.push([
      await decodeAbiType(view, elementOffset, type.key),
      await decodeAbiType(view, elementOffset + valueOffset, type.value),
    ]);
  }

  const flagsOffset = roundUp(
    offset + type.capacity * elementStride,
    8,
  );
  const flags = decodeUint64Array(view, flagsOffset, flagWordCount(type.capacity));
  const countersOffset = flagsOffset + flags.length * 8;
  return [
    elements,
    flags,
    view.getBigUint64(countersOffset, true),
    view.getBigUint64(countersOffset + 8, true),
  ];
}

async function decodeAbiHashSet(
  view: DataView,
  offset: number,
  type: Extract<AbiType, { kind: AbiTypeKind.HASH_SET }>,
): Promise<any[]> {
  const keyStride = roundUp(type.key.size, type.key.align);
  const keys: any[] = [];
  for (let index = 0; index < type.capacity; index++) {
    keys.push(
      await decodeAbiType(view, offset + index * keyStride, type.key),
    );
  }

  const flagsOffset = roundUp(offset + type.capacity * keyStride, 8);
  const flags = decodeUint64Array(view, flagsOffset, flagWordCount(type.capacity));
  const countersOffset = flagsOffset + flags.length * 8;
  return [
    keys,
    flags,
    view.getBigUint64(countersOffset, true),
    view.getBigUint64(countersOffset + 8, true),
  ];
}

async function decodeAbiCollection(
  view: DataView,
  offset: number,
  type: Extract<AbiType, { kind: AbiTypeKind.COLLECTION }>,
): Promise<any[]> {
  const povStride = 64;
  const povs: any[] = [];
  for (let index = 0; index < type.capacity; index++) {
    const povOffset = offset + index * povStride;
    povs.push([
      await decodeAbiScalar(view, povOffset, AbiScalarKind.ID),
      view.getBigUint64(povOffset + 32, true),
      view.getBigInt64(povOffset + 40, true),
      view.getBigInt64(povOffset + 48, true),
      view.getBigInt64(povOffset + 56, true),
    ]);
  }

  const flagsOffset = offset + type.capacity * povStride;
  const flags = decodeUint64Array(view, flagsOffset, flagWordCount(type.capacity));
  const valueOffset = roundUp(
    flagsOffset + flags.length * 8,
    Math.max(type.value.align, 8),
  );
  const priorityOffset = roundUp(type.value.size, 8);
  const elementStride = roundUp(
    priorityOffset + 5 * 8,
    Math.max(type.value.align, 8),
  );
  const elements: any[] = [];
  for (let index = 0; index < type.capacity; index++) {
    const elementOffset = valueOffset + index * elementStride;
    elements.push([
      await decodeAbiType(view, elementOffset, type.value),
      view.getBigInt64(elementOffset + priorityOffset, true),
      view.getBigInt64(elementOffset + priorityOffset + 8, true),
      view.getBigInt64(elementOffset + priorityOffset + 16, true),
      view.getBigInt64(elementOffset + priorityOffset + 24, true),
      view.getBigInt64(elementOffset + priorityOffset + 32, true),
    ]);
  }

  const countersOffset = valueOffset + type.capacity * elementStride;
  return [
    povs,
    flags,
    elements,
    view.getBigUint64(countersOffset, true),
    view.getBigUint64(countersOffset + 8, true),
  ];
}

function decodeUint64Array(
  view: DataView,
  offset: number,
  count: number,
): bigint[] {
  return Array.from(
    { length: count },
    (_, index) => view.getBigUint64(offset + index * 8, true),
  );
}

async function decodeAbiScalar(
  view: DataView,
  offset: number,
  scalar: AbiScalarKind,
): Promise<any> {
  switch (scalar) {
    case AbiScalarKind.BIT:
    case AbiScalarKind.UINT8:
      return view.getUint8(offset);
    case AbiScalarKind.SINT8:
      return view.getInt8(offset);
    case AbiScalarKind.UINT16:
      return view.getUint16(offset, true);
    case AbiScalarKind.SINT16:
      return view.getInt16(offset, true);
    case AbiScalarKind.UINT32:
      return view.getUint32(offset, true);
    case AbiScalarKind.SINT32:
      return view.getInt32(offset, true);
    case AbiScalarKind.UINT64:
      return view.getBigUint64(offset, true);
    case AbiScalarKind.SINT64:
      return view.getBigInt64(offset, true);
    case AbiScalarKind.UINT128:
      return readUint128(view, offset);
    case AbiScalarKind.SINT128: {
      const value = readUint128(view, offset);
      return value >= 1n << 127n ? value - (1n << 128n) : value;
    }
    case AbiScalarKind.ID: {
      const bytes = new Uint8Array(32);
      for (let index = 0; index < bytes.length; index++) {
        bytes[index] = view.getUint8(offset + index);
      }
      return await bytesToIdentity(bytes);
    }
    case AbiScalarKind.M256I: {
      let hex = "";
      for (let index = 0; index < 32; index++) {
        hex += view.getUint8(offset + index).toString(16).padStart(2, "0");
      }
      return hex;
    }
  }
}

function readUint128(view: DataView, offset: number): bigint {
  const low = view.getBigUint64(offset, true);
  const high = view.getBigUint64(offset + 8, true);
  return (high << 64n) | low;
}

function assertBounds(view: DataView, offset: number, size: number): void {
  if (offset < 0 || size < 0 || offset + size > view.byteLength) {
    throw new RangeError(
      `ABI value at ${offset} with size ${size} exceeds ${view.byteLength} bytes`,
    );
  }
}

export async function decodeOutput(
  bytes: Uint8Array,
  fmt: string | AbiType,
): Promise<any> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoded = typeof fmt === "string"
    ? (await decodeNode(view, 0, parseLayout(fmt)))[0]
    : await decodeAbiType(view, 0, fmt);
  if (typeof fmt !== "string" && fmt.kind === AbiTypeKind.STRUCT) {
    if (fmt.fields.length === 0) {
      return [];
    }
    if (fmt.fields.length === 1) {
      return decoded[0];
    }
  }
  return decoded;
}

// ---------- input encode (value-driven, aligned, async for id) ----------
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex: '${hex}'`);
  const out = new Uint8Array(h.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16);
  return out;
}

async function encodeAbiType(
  view: DataView,
  offset: number,
  type: AbiType,
  value: any,
): Promise<void> {
  assertBounds(view, offset, type.size);

  switch (type.kind) {
    case AbiTypeKind.SCALAR:
      await encodeAbiScalar(view, offset, type.scalar, value);
      return;
    case AbiTypeKind.STRUCT: {
      if (hasOverlappingFields(type)) {
        writeRawAbiValue(view, offset, type, value);
        return;
      }
      const values = structValues(type, value);
      for (let index = 0; index < type.fields.length; index++) {
        const field = type.fields[index];
        await encodeAbiType(
          view,
          offset + field.offset,
          field.type,
          values[index],
        );
      }
      return;
    }
    case AbiTypeKind.ARRAY: {
      if (!Array.isArray(value)) {
        throw new Error(`array '${formatAbiType(type)}' needs a JSON array`);
      }
      if (value.length !== type.count) {
        throw new Error(
          `array '${formatAbiType(type)}' expects ${type.count} elements, got ${value.length}`,
        );
      }
      const stride = roundUp(type.element.size, type.element.align);
      for (let index = 0; index < type.count; index++) {
        await encodeAbiType(
          view,
          offset + index * stride,
          type.element,
          value[index],
        );
      }
      return;
    }
    default:
      writeRawAbiValue(view, offset, type, value);
  }
}

function writeRawAbiValue(
  view: DataView,
  offset: number,
  type: AbiType,
  value: any,
): void {
  if (
    !(value instanceof Uint8Array) &&
    !Array.isArray(value)
  ) {
    throw new Error(`${type.kind} input needs exactly ${type.size} raw bytes`);
  }
  if (value.length !== type.size) {
    throw new Error(`${type.kind} input needs exactly ${type.size} raw bytes`);
  }
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`raw byte ${index} must be an integer from 0 to 255`);
    }
    view.setUint8(offset + index, byte);
  }
}

function hasOverlappingFields(type: AbiStruct): boolean {
  for (let index = 0; index < type.fields.length; index++) {
    const field = type.fields[index];
    for (let previousIndex = 0; previousIndex < index; previousIndex++) {
      const previous = type.fields[previousIndex];
      if (
        field.size > 0 &&
        previous.size > 0 &&
        field.offset < previous.offset + previous.size &&
        previous.offset < field.offset + field.size
      ) {
        return true;
      }
    }
  }
  return false;
}

function structValues(type: AbiStruct, value: any): any[] {
  if (Array.isArray(value)) {
    if (value.length !== type.fields.length) {
      throw new Error(
        `struct '${type.name ?? type.format}' expects ${type.fields.length} values, got ${value.length}`,
      );
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`struct '${type.name ?? type.format}' needs a JSON object`);
  }
  return type.fields.map((field) => {
    if (!(field.name in value)) {
      throw new Error(`missing input field '${field.name}'`);
    }
    return value[field.name];
  });
}

async function encodeAbiScalar(
  view: DataView,
  offset: number,
  scalar: AbiScalarKind,
  value: any,
): Promise<void> {
  if (scalar === AbiScalarKind.ID) {
    const text = String(value);
    let bytes: Uint8Array;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
      bytes = hexToBytes(text);
    } else if (/^[A-Z]{60}$/.test(text)) {
      bytes = identityToBytes(text);
    } else {
      throw new Error(
        `id must be a 60-char identity (A-Z) or a 64-hex pubkey, got '${text}'`,
      );
    }
    writeBytes(view, offset, bytes);
    return;
  }

  if (scalar === AbiScalarKind.M256I) {
    const text = String(value).replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(text)) {
      throw new Error(`m256i must be 64 hex chars (32 bytes), got '${text}'`);
    }
    writeBytes(view, offset, hexToBytes(text));
    return;
  }

  const number = scalar === AbiScalarKind.BIT && typeof value === "boolean"
    ? BigInt(value ? 1 : 0)
    : integerValue(value, scalar);
  const bits = scalarBits(scalar);
  const signed = scalar.startsWith("sint");
  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = scalar === AbiScalarKind.BIT
    ? 1n
    : signed
      ? (1n << BigInt(bits - 1)) - 1n
      : (1n << BigInt(bits)) - 1n;
  if (number < minimum || number > maximum) {
    throw new Error(
      `${scalar} out of range: ${number} (allowed ${minimum}..${maximum})`,
    );
  }

  const encoded = BigInt.asUintN(bits, number);
  if (bits === 128) {
    view.setBigUint64(offset, encoded & ((1n << 64n) - 1n), true);
    view.setBigUint64(offset + 8, encoded >> 64n, true);
  } else if (bits === 64) {
    view.setBigUint64(offset, encoded, true);
  } else if (bits === 32) {
    view.setUint32(offset, Number(encoded), true);
  } else if (bits === 16) {
    view.setUint16(offset, Number(encoded), true);
  } else {
    view.setUint8(offset, Number(encoded));
  }
}

function integerValue(value: any, scalar: AbiScalarKind): bigint {
  if (value === undefined || value === null) {
    throw new Error(`missing value for '${scalar}'`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${scalar} needs an integer, got '${String(value)}'`);
  }
}

function scalarBits(scalar: AbiScalarKind): 8 | 16 | 32 | 64 | 128 {
  switch (scalar) {
    case AbiScalarKind.BIT:
    case AbiScalarKind.UINT8:
    case AbiScalarKind.SINT8:
      return 8;
    case AbiScalarKind.UINT16:
    case AbiScalarKind.SINT16:
      return 16;
    case AbiScalarKind.UINT32:
    case AbiScalarKind.SINT32:
      return 32;
    case AbiScalarKind.UINT64:
    case AbiScalarKind.SINT64:
      return 64;
    case AbiScalarKind.UINT128:
    case AbiScalarKind.SINT128:
      return 128;
    default:
      throw new Error(`'${scalar}' is not an integer scalar`);
  }
}

function writeBytes(view: DataView, offset: number, bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index++) {
    view.setUint8(offset + index, bytes[index]);
  }
}

// Split by top-level commas, respecting [] and {} nesting.
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    cur = "";
  for (const ch of s) {
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).filter((x) => x.length);
}

// Expand `<token> ×N` using ×, *, or x as the multiplier; spaces are optional.
const REPEAT_RE = /^(.+?)\s*[×*x]\s*(\d+)$/;
function expandReps(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const m = p.match(REPEAT_RE);
    if (m) {
      const tok = m[1].trim();
      const n = parseInt(m[2], 10);
      for (let k = 0; k < n; k++) out.push(tok);
    } else out.push(p);
  }
  return out;
}

// Alignment of a value token (mirrors alignOf on the type the value carries).
function tokenAlign(tok: string): number {
  tok = tok.trim().replace(REPEAT_RE, "$1").trim(); // a "tok ×N" repeat aligns as the base token

  if (tok[0] === "{") {
    const p = splitTop(tok.slice(1, tok.lastIndexOf("}")));
    return p.length ? Math.max(...p.map(tokenAlign)) : 1;
  }
  if (tok[0] === "[") {
    const inner = tok.slice(1, tok.lastIndexOf("]"));
    const semi = inner.indexOf(";");
    const p = splitTop(semi >= 0 ? inner.slice(semi + 1) : inner);
    return p.length ? tokenAlign(p[0]) : 1;
  }
  if (tok.endsWith("id")) return 8;
  if (tok.endsWith("m256i")) return 8;
  if (tok.endsWith("uint128")) return 8;
  const m = tok.match(/^-?\d+([a-z0-9]+)$/);
  return m ? (SCALAR_SIZE[m[1]] ?? 1) : 1;
}
const padTo = (out: number[], align: number) => {
  while (align > 1 && out.length % align) out.push(0);
};

// Encode one value token at the current (aligned) offset = out.length.
async function encodeToken(tok: string, out: number[]): Promise<void> {
  tok = tok.trim();
  if (!tok) return;
  if (tok[0] === "{") {
    const parts = expandReps(splitTop(tok.slice(1, tok.lastIndexOf("}"))));
    const sa = parts.length ? Math.max(...parts.map(tokenAlign)) : 1;
    padTo(out, sa);
    if (parts.length === 0) {
      out.push(0);
    }
    for (const t of parts) await encodeToken(t, out);
    padTo(out, sa); // trailing struct padding
    return;
  }
  if (tok[0] === "[") {
    const inner = tok.slice(1, tok.lastIndexOf("]"));
    const semi = inner.indexOf(";");
    const parts = expandReps(splitTop(semi >= 0 ? inner.slice(semi + 1) : inner));
    for (const t of parts) await encodeToken(t, out); // each elem self-aligns -> stride
    return;
  }
  if (tok.endsWith("id")) {
    const v = tok.slice(0, -2).trim();
    let b: Uint8Array;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) b = hexToBytes(v);
    else if (/^[A-Z]{60}$/.test(v)) b = identityToBytes(v);
    else throw new Error(`id must be a 60-char identity (A-Z) or a 64-hex pubkey, got '${v}'`);
    if (b.length !== 32) throw new Error(`id did not resolve to 32 bytes: '${v}'`);
    padTo(out, 8);
    for (const x of b) out.push(x);
    return;
  }
  if (tok.endsWith("m256i")) {
    const v = tok.slice(0, -5).trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(v))
      throw new Error(`m256i must be 64 hex chars (32 bytes), got '${v}'`);
    padTo(out, 8);
    for (const x of hexToBytes(v)) out.push(x);
    return;
  }
  if (tok.endsWith("uint128")) {
    const numStr = tok.slice(0, -7).trim();
    if (!/^-?\d+$/.test(numStr))
      throw new Error(`uint128 must be an unsigned integer, got '${numStr}'`);
    const val = BigInt(numStr);
    const max = (1n << 128n) - 1n;
    if (val < 0n || val > max)
      throw new Error(`uint128 out of range: ${numStr} (allowed 0..${max})`);
    padTo(out, 8);
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setBigUint64(0, val & ((1n << 64n) - 1n), true);
    dv.setBigUint64(8, val >> 64n, true);
    for (const x of buf) out.push(x);
    return;
  }
  const m = tok.match(/^(-?\d+)([a-z0-9]+)$/);
  if (!m)
    throw new Error(`cannot parse value token '${tok}' (expected <number><type>, e.g. 5uint64)`);
  const [, numStr, type] = m;
  const size = SCALAR_SIZE[type];
  if (!size) throw new Error(`unknown type '${type}' in '${tok}'`);
  const signed = type.startsWith("sint");
  const val = BigInt(numStr);
  if (type === "bit") {
    if (val < 0n || val > 1n) throw new Error(`bit must be 0 or 1, got ${numStr}`);
  } else {
    const bits = BigInt(size * 8);
    const min = signed ? -(1n << (bits - 1n)) : 0n;
    const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    if (val < min || val > max)
      throw new Error(`${type} out of range: ${numStr} (allowed ${min}..${max})`);
  }
  padTo(out, size);
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  if (size === 8)
    dv.setBigUint64(0, val & ((1n << 64n) - 1n), true); // mask -> two's complement
  else if (size === 4) dv.setUint32(0, Number(val) >>> 0, true);
  else if (size === 2) dv.setUint16(0, Number(val) & 0xffff, true);
  else dv.setUint8(0, Number(val) & 0xff);
  for (const x of buf) out.push(x);
}

// ---------- JSON -> input value-format (field-name keyed; reuses the encodeInput grammar) ----------
// Build encodeInput's value format from named JSON fields or positional nested arrays.
function jsonValueToFmt(typeTok: string, value: any): string {
  typeTok = typeTok.trim();
  if (typeTok[0] === "{") {
    const parts = splitTop(typeTok.slice(1, typeTok.lastIndexOf("}")));
    if (!Array.isArray(value))
      throw new Error(
        `nested struct '${typeTok}' needs a positional JSON array, got ${JSON.stringify(value)}`,
      );
    if (value.length !== parts.length)
      throw new Error(`struct '${typeTok}' expects ${parts.length} values, got ${value.length}`);
    return `{ ${parts.map((p, i) => jsonValueToFmt(p, value[i])).join(", ")} }`;
  }
  if (typeTok[0] === "[") {
    const inner = typeTok.slice(1, typeTok.lastIndexOf("]"));
    const semi = inner.indexOf(";");
    const n = parseInt(inner.slice(0, semi), 10);
    const elem = inner.slice(semi + 1).trim();
    if (!Array.isArray(value))
      throw new Error(`array '${typeTok}' needs a JSON array, got ${JSON.stringify(value)}`);
    if (value.length !== n)
      throw new Error(`array '${typeTok}' expects ${n} elements, got ${value.length}`);
    return `[${n}; ${value.map((v) => jsonValueToFmt(elem, v)).join(", ")}]`;
  }
  if (typeTok === "id" || typeTok === "m256i") {
    const s = String(value).replace(/^0x/, "");
    return `${s}${typeTok}`; // encodeToken validates the identity/hex shape
  }
  if (typeof value === "boolean") return `${value ? 1 : 0}${typeTok}`;
  if (value === undefined || value === null) throw new Error(`missing value for '${typeTok}'`);
  return `${BigInt(value)}${typeTok}`; // number / bigint / numeric-string; rejects floats
}

type InputFields = { name: string; type: string }[] | AbiType;

export function jsonToInputFmt(fields: InputFields, json: any): string {
  if (!Array.isArray(fields)) {
    if (fields.kind !== AbiTypeKind.STRUCT) {
      return typedJsonValueToFmt(fields, json);
    }
    const values = structValues(fields, json);
    return fields.fields
      .map((field, index) => typedJsonValueToFmt(field.type, values[index]))
      .join(", ");
  }
  const arr = Array.isArray(json)
    ? json
    : fields.map((f) => {
        if (json == null || !(f.name in json)) throw new Error(`missing input field '${f.name}'`);
        return json[f.name];
      });
  return fields.map((f, i) => jsonValueToFmt(f.type, arr[i])).join(", ");
}

export async function encodeInputJson(
  fields: InputFields,
  json: any,
): Promise<Uint8Array> {
  if (!Array.isArray(fields)) {
    const bytes = new Uint8Array(fields.size);
    await encodeAbiType(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      0,
      fields,
      json,
    );
    return bytes;
  }
  return encodeInput(jsonToInputFmt(fields, json));
}

function typedJsonValueToFmt(type: AbiType, value: any): string {
  if (type.kind === AbiTypeKind.STRUCT) {
    if (hasOverlappingFields(type)) {
      throw new Error("overlapping struct input requires raw bytes");
    }
    const values = structValues(type, value);
    return `{ ${type.fields
      .map((field, index) => typedJsonValueToFmt(field.type, values[index]))
      .join(", ")} }`;
  }
  if (type.kind === AbiTypeKind.ARRAY) {
    if (!Array.isArray(value)) {
      throw new Error(`array '${formatAbiType(type)}' needs a JSON array`);
    }
    if (value.length !== type.count) {
      throw new Error(
        `array '${formatAbiType(type)}' expects ${type.count} elements, got ${value.length}`,
      );
    }
    return `[${type.count}; ${value
      .map((item) => typedJsonValueToFmt(type.element, item))
      .join(", ")}]`;
  }
  return jsonValueToFmt(formatAbiType(type), value);
}

// Build an ALL-ZERO input value-format from a type-format (the input scheme) — same grammar encodeInput
// consumes — so a user whose input fails to parse gets a valid, copy-pasteable sample matching their entry.
export function zeroInputFmt(fmt: string | AbiType): string {
  if (typeof fmt !== "string" && hasOverlappingAbiType(fmt)) {
    return `[${fmt.size}; 0uint8 ×${fmt.size}]`;
  }
  const emit = (n: TypeNode): string => {
    switch (n.kind) {
      case "scalar":
        return `0${n.type}`;
      case "uint128":
        return "0uint128";
      case "id":
        return `${"0".repeat(64)}id`;
      case "bytes":
        if (n.size === 32) return `${"0".repeat(64)}m256i`;
        throw new Error(`no input token for ${n.size}-byte field`);
      case "array":
        return `[${n.count}; ${emit(n.elem)} ×${n.count}]`;
      case "struct":
        return `{ ${n.fields.map(emit).join(", ")} }`;
    }
  };
  const node = typeof fmt === "string" ? parseLayout(fmt) : nodeOf(fmt);
  // top-level struct renders WITHOUT braces (mirrors encodeInput's implicit top-level struct of the input fields)
  return node.kind === "struct" ? node.fields.map(emit).join(", ") : emit(node);
}

export function hasOverlappingAbiType(type: AbiType): boolean {
  switch (type.kind) {
    case AbiTypeKind.SCALAR:
      return false;
    case AbiTypeKind.STRUCT:
      return hasOverlappingFields(type) ||
        type.fields.some((field) => hasOverlappingAbiType(field.type));
    case AbiTypeKind.ARRAY:
      return hasOverlappingAbiType(type.element);
    case AbiTypeKind.COLLECTION:
      return hasOverlappingAbiType(type.value);
    case AbiTypeKind.HASH_MAP:
      return hasOverlappingAbiType(type.key) ||
        hasOverlappingAbiType(type.value);
    case AbiTypeKind.HASH_SET:
      return hasOverlappingAbiType(type.key);
  }
}

// Top-level value tokens (comma-separated) = an implicit struct. "" = empty input.
export async function encodeInput(fmt: string): Promise<Uint8Array> {
  const t = (fmt ?? "").trim();
  if (!t) return new Uint8Array(1);
  const parts = expandReps(splitTop(t));
  const out: number[] = [];
  const sa = parts.length ? Math.max(...parts.map(tokenAlign)) : 1;
  for (const tok of parts) await encodeToken(tok, out);
  padTo(out, sa); // round the whole input struct to its alignment
  return new Uint8Array(out);
}
