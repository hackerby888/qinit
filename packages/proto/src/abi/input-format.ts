// The input value grammar behind `--in`, and everything that writes ABI bytes.
import { hexToBytes, identityToBytes } from "@qinit/core";
import { AbiScalarKind, AbiTypeKind, forbiddenPublicType, formatAbiType, type AbiStruct, type AbiType } from "../contract-idl";
import { arrayGeometry, bitWordCount } from "../qpi-layout";
import { assertBounds } from "./decode";
import { hasOverlappingAbiType, hasOverlappingFields, nodeOf, parseTypeFormat, SCALAR_SIZE, splitTop, type TypeNode } from "./type-format";

// input encode (value-driven, aligned, async for id)
async function encodeAbiType(view: DataView, offset: number, type: AbiType, value: any): Promise<void> {
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
                await encodeAbiType(view, offset + field.offset, field.type, values[index]);
            }
            return;
        }
        case AbiTypeKind.ARRAY: {
            if (!Array.isArray(value)) {
                throw new Error(`array '${formatAbiType(type)}' needs a JSON array`);
            }
            if (value.length !== type.count) {
                throw new Error(`array '${formatAbiType(type)}' expects ${type.count} elements, got ${value.length}`);
            }
            const { stride } = arrayGeometry(type.element, type.count);
            for (let index = 0; index < type.count; index++) {
                await encodeAbiType(view, offset + index * stride, type.element, value[index]);
            }
            return;
        }
        case AbiTypeKind.BIT_ARRAY: {
            const bits = bitArrayValue(type.bitCount, value);
            for (let index = 0; index < type.size; index++) {
                view.setUint8(offset + index, 0);
            }
            for (let index = 0; index < bits.length; index++) {
                if (!bits[index]) continue;
                const byteOffset = offset + Math.floor(index / 8);
                view.setUint8(byteOffset, view.getUint8(byteOffset) | (1 << (index & 7)));
            }
            return;
        }
        case AbiTypeKind.LINKED_LIST:
            throw new Error("LinkedList input is not supported");
        default:
            writeRawAbiValue(view, offset, type, value);
    }
}

function writeRawAbiValue(view: DataView, offset: number, type: AbiType, value: any): void {
    if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
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

function structValues(type: AbiStruct, value: any): any[] {
    if (Array.isArray(value)) {
        if (value.length !== type.fields.length) {
            throw new Error(`struct '${type.name ?? type.format}' expects ${type.fields.length} values, got ${value.length}`);
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

async function encodeAbiScalar(view: DataView, offset: number, scalar: AbiScalarKind, value: any): Promise<void> {
    if (scalar === AbiScalarKind.ID) {
        const text = String(value);
        let bytes: Uint8Array;
        if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
            bytes = hexToBytes(text);
        } else if (/^[A-Z]{60}$/.test(text)) {
            bytes = identityToBytes(text);
        } else {
            throw new Error(`id must be a 60-char identity (A-Z) or a 64-hex pubkey, got '${text}'`);
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

    const number = scalar === AbiScalarKind.BIT && typeof value === "boolean" ? BigInt(value ? 1 : 0) : integerValue(value, scalar);
    const bits = scalarBits(scalar);
    const signed = scalar.startsWith("sint");
    const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const maximum = scalar === AbiScalarKind.BIT ? 1n : signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    if (number < minimum || number > maximum) {
        throw new Error(`${scalar} out of range: ${number} (allowed ${minimum}..${maximum})`);
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
    if (tok.endsWith("sint128")) return 8;
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
        // lastIndexOf returns -1 when the closer is absent and slice(1, -1) would silently drop the last character, so a mismatched bracket is caught here.
        if (tok[tok.length - 1] !== "}") throw new Error(`struct value is missing its closing '}': '${tok}'`);
        const parts = expandReps(splitTop(tok.slice(1, -1)));
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
        if (tok[tok.length - 1] !== "]") throw new Error(`array value is missing its closing ']': '${tok}'`);
        const inner = tok.slice(1, -1);
        const semi = inner.indexOf(";");
        const parts = expandReps(splitTop(semi >= 0 ? inner.slice(semi + 1) : inner));
        if (semi >= 0) {
            // Same strictness as the type dialect: parseInt would read '2uint64' as 2 and leave NaN counts unchecked.
            const rawCount = inner.slice(0, semi).trim();
            if (!/^\d+$/.test(rawCount)) throw new Error(`array count '${rawCount}' must be a non-negative integer`);
            const count = parseInt(rawCount, 10);
            if (parts.length !== count) {
                throw new Error(`array of ${count} needs ${count} values, got ${parts.length}`);
            }
        }
        for (const t of parts) await encodeToken(t, out); // each elem self-aligns -> stride
        return;
    }
    if (tok.endsWith("id")) {
        const v = tok.slice(0, -2).trim();
        let b: Uint8Array;
        if (v === "0") b = new Uint8Array(32);
        else if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) b = hexToBytes(v);
        else if (/^[A-Z]{60}$/.test(v)) b = identityToBytes(v);
        else throw new Error(`id must be 0, a 60-char identity (A-Z), or a 64-hex pubkey, got '${v}'`);
        if (b.length !== 32) throw new Error(`id did not resolve to 32 bytes: '${v}'`);
        padTo(out, 8);
        for (const x of b) out.push(x);
        return;
    }
    if (tok.endsWith("m256i")) {
        const v = tok.slice(0, -5).trim().replace(/^0x/, "");
        const hex = v === "0" ? "0".repeat(64) : v;
        if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`m256i must be 0 or 64 hex chars (32 bytes), got '${v}'`);
        padTo(out, 8);
        for (const x of hexToBytes(hex)) out.push(x);
        return;
    }
    if (tok.endsWith("sint128")) {
        const numStr = tok.slice(0, -7).trim();
        if (!/^-?\d+$/.test(numStr)) throw new Error(`sint128 must be an integer, got '${numStr}'`);
        const val = BigInt(numStr);
        const min = -(1n << 127n);
        const max = (1n << 127n) - 1n;
        if (val < min || val > max) throw new Error(`sint128 out of range: ${numStr} (allowed ${min}..${max})`);
        padTo(out, 8);
        const buf = new Uint8Array(16);
        const dv = new DataView(buf.buffer);
        const encoded = BigInt.asUintN(128, val); // two's complement, low limb first
        dv.setBigUint64(0, encoded & ((1n << 64n) - 1n), true);
        dv.setBigUint64(8, encoded >> 64n, true);
        for (const x of buf) out.push(x);
        return;
    }
    if (tok.endsWith("uint128")) {
        const numStr = tok.slice(0, -7).trim();
        if (!/^-?\d+$/.test(numStr)) throw new Error(`uint128 must be an unsigned integer, got '${numStr}'`);
        const val = BigInt(numStr);
        const max = (1n << 128n) - 1n;
        if (val < 0n || val > max) throw new Error(`uint128 out of range: ${numStr} (allowed 0..${max})`);
        padTo(out, 8);
        const buf = new Uint8Array(16);
        const dv = new DataView(buf.buffer);
        dv.setBigUint64(0, val & ((1n << 64n) - 1n), true);
        dv.setBigUint64(8, val >> 64n, true);
        for (const x of buf) out.push(x);
        return;
    }
    const { numStr, type } = scalarToken(tok);
    const size = SCALAR_SIZE[type];
    const signed = type.startsWith("sint");
    const val = BigInt(numStr);
    if (type === "bit") {
        if (val < 0n || val > 1n) throw new Error(`bit must be 0 or 1, got ${numStr}`);
    } else {
        const bits = BigInt(size * 8);
        const min = signed ? -(1n << (bits - 1n)) : 0n;
        const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
        if (val < min || val > max) throw new Error(`${type} out of range: ${numStr} (allowed ${min}..${max})`);
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

// A <number><type> token. Hex and exponent spellings are named outright: the generic regex would split '0x10uint64' at the 'x' and blame an unknown type.
function scalarToken(tok: string): { numStr: string; type: string } {
    if (/^-?0x/i.test(tok)) throw new Error(`hex is not accepted, write '${tok}' in decimal`);
    if (/^-?\d+e\d/i.test(tok)) throw new Error(`exponent notation is not accepted, write '${tok}' in full`);
    const m = tok.match(/^(-?\d+)([a-z0-9]+)$/);
    if (!m) throw new Error(`cannot parse value token '${tok}' (expected <number><type>, e.g. 5uint64)`);
    const [, numStr, type] = m;
    if (!SCALAR_SIZE[type]) throw new Error(`unknown type '${type}' in '${tok}'`);
    return { numStr, type };
}

// JSON -> input value-format, field-name keyed: builds encodeInputFormat's value format from named JSON fields or positional nested arrays.
function jsonValueToInputFormat(typeTok: string, value: any): string {
    typeTok = typeTok.trim();
    if (typeTok[0] === "{") {
        const parts = splitTop(typeTok.slice(1, typeTok.lastIndexOf("}")));
        if (!Array.isArray(value)) throw new Error(`nested struct '${typeTok}' needs a positional JSON array, got ${JSON.stringify(value)}`);
        if (value.length !== parts.length) throw new Error(`struct '${typeTok}' expects ${parts.length} values, got ${value.length}`);
        return `{ ${parts.map((p, i) => jsonValueToInputFormat(p, value[i])).join(", ")} }`;
    }
    if (typeTok[0] === "[") {
        const inner = typeTok.slice(1, typeTok.lastIndexOf("]"));
        const semi = inner.indexOf(";");
        const n = parseInt(inner.slice(0, semi), 10);
        const elem = inner.slice(semi + 1).trim();
        if (!Array.isArray(value)) throw new Error(`array '${typeTok}' needs a JSON array, got ${JSON.stringify(value)}`);
        if (value.length !== n) throw new Error(`array '${typeTok}' expects ${n} elements, got ${value.length}`);
        return `[${n}; ${value.map((v) => jsonValueToInputFormat(elem, v)).join(", ")}]`;
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

function rejectComplexInput(fields: InputFields): void {
    const forbidden = Array.isArray(fields) ? undefined : forbiddenPublicType(fields);
    if (forbidden) {
        throw new Error(`${forbidden} input is not supported`);
    }
}

// JSON -> value text, e.g. { amount: 1 } -> "1uint64".
export function jsonToInputFormat(fields: InputFields, json: any): string {
    rejectComplexInput(fields);
    if (!Array.isArray(fields)) {
        if (fields.kind !== AbiTypeKind.STRUCT) {
            return typedJsonValueToInputFormat(fields, json);
        }
        const values = structValues(fields, json);
        return fields.fields.map((field, index) => typedJsonValueToInputFormat(field.type, values[index])).join(", ");
    }
    const arr = Array.isArray(json)
        ? json
        : fields.map((f) => {
              if (json == null || !(f.name in json)) throw new Error(`missing input field '${f.name}'`);
              return json[f.name];
          });
    return fields.map((f, i) => jsonValueToInputFormat(f.type, arr[i])).join(", ");
}

// JSON text -> value, keeping an integer past 2^53 exact as a string: JSON.parse rounds it before any range check sees it, so the reviver reads the source text.
export function parseInputJson(text: string): any {
    type Reviver = (this: any, key: string, value: any, context?: { source?: string }) => any;
    const exact: Reviver = (_key, value, context) => {
        if (typeof value !== "number" || Number.isSafeInteger(value) || !Number.isInteger(value)) {
            return value;
        }
        if (context?.source === undefined) {
            throw new Error(`integer ${value} is past 2^53: quote it as a string`);
        }
        return /^-?\d+$/.test(context.source) ? context.source : value;
    };
    return JSON.parse(text, exact as (key: string, value: any) => any);
}

// JSON -> bytes, e.g. { amount: 1 } for "{ uint64 amount }" -> 01 00 00 00 00 00 00 00.
export async function encodeInputJson(fields: InputFields, json: any): Promise<Uint8Array> {
    rejectComplexInput(fields);
    if (!Array.isArray(fields)) {
        const bytes = new Uint8Array(fields.size);
        await encodeAbiType(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, fields, json);
        return bytes;
    }
    return encodeInputFormat(jsonToInputFormat(fields, json));
}

function typedJsonValueToInputFormat(type: AbiType, value: any): string {
    if (type.kind === AbiTypeKind.STRUCT) {
        if (hasOverlappingFields(type)) {
            throw new Error("overlapping struct input requires raw bytes");
        }
        const values = structValues(type, value);
        return `{ ${type.fields.map((field, index) => typedJsonValueToInputFormat(field.type, values[index])).join(", ")} }`;
    }
    if (type.kind === AbiTypeKind.ARRAY) {
        if (!Array.isArray(value)) {
            throw new Error(`array '${formatAbiType(type)}' needs a JSON array`);
        }
        if (value.length !== type.count) {
            throw new Error(`array '${formatAbiType(type)}' expects ${type.count} elements, got ${value.length}`);
        }
        return `[${type.count}; ${value.map((item) => typedJsonValueToInputFormat(type.element, item)).join(", ")}]`;
    }
    if (type.kind === AbiTypeKind.BIT_ARRAY) {
        const bits = bitArrayValue(type.bitCount, value);
        const words = Array.from({ length: bitWordCount(type.bitCount) }, () => 0n);
        for (let index = 0; index < bits.length; index++) {
            if (bits[index]) {
                words[Math.floor(index / 64)] |= 1n << BigInt(index & 63);
            }
        }
        return `[${words.length}; ${words.map((word) => `${word}uint64`).join(", ")}]`;
    }
    if (type.kind === AbiTypeKind.LINKED_LIST) {
        throw new Error("LinkedList input is not supported");
    }
    return jsonValueToInputFormat(formatAbiType(type), value);
}

function bitArrayValue(bitCount: number, value: any): number[] {
    if (!Array.isArray(value)) {
        throw new Error(`bit_array expects a JSON array with ${bitCount} bits`);
    }
    if (value.length !== bitCount) {
        throw new Error(`bit_array expects ${bitCount} bits, got ${value.length}`);
    }
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0 && value[index] !== 1) {
            throw new Error(`bit_array bit ${index} must be 0 or 1`);
        }
    }
    return value;
}

// Type -> an all-zero value text sample, e.g. "{ uint64, id }" -> "0uint64, 0id", so a user whose input fails to parse gets a copy-pasteable one.
export function zeroInputFormat(type: string | AbiType): string {
    if (typeof type !== "string" && hasOverlappingAbiType(type)) {
        return `[${type.size}; 0uint8 ×${type.size}]`;
    }
    const emit = (n: TypeNode): string => {
        switch (n.kind) {
            case "scalar":
                return `0${n.type}`;
            case "uint128":
                return "0uint128";
            case "sint128":
                return "0sint128";
            case "id":
                return "0id";
            case "bytes":
                if (n.size === 32) return "0m256i";
                throw new Error(`no input token for ${n.size}-byte field`);
            case "array":
                return `[${n.count}; ${emit(n.elem)} ×${n.count}]`;
            case "struct":
                return `{ ${n.fields.map(emit).join(", ")} }`;
        }
    };
    const node = typeof type === "string" ? parseTypeFormat(type) : nodeOf(type);
    // top-level struct renders WITHOUT braces (mirrors encodeInputFormat's implicit top-level struct of the input fields)
    return node.kind === "struct" ? node.fields.map(emit).join(", ") : emit(node);
}

// Value text -> bytes, with no schema, e.g. "1uint32" -> 01 00 00 00. Top-level tokens are an implicit struct; "" is an empty input.
export async function encodeInputFormat(inputFormat: string): Promise<Uint8Array> {
    const t = (inputFormat ?? "").trim();
    if (!t) return new Uint8Array(1);
    const parts = expandReps(splitTop(t));
    const out: number[] = [];
    const sa = parts.length ? Math.max(...parts.map(tokenAlign)) : 1;
    for (const tok of parts) await encodeToken(tok, out);
    padTo(out, sa); // round the whole input struct to its alignment
    return new Uint8Array(out);
}

// --in against the IDL: every token checked against the field it lands in
export type InputFormatStruct = { kind: "struct"; items: InputFormatNode[]; raw: string };
export type InputFormatNode =
    InputFormatStruct | { kind: "array"; count: number | null; items: InputFormatNode[]; raw: string } | { kind: "scalar"; type: string; text: string; raw: string };

const WIDE_SUFFIXES = ["m256i", "uint128", "sint128", "id"];

// Value text -> token tree, e.g. "{1uint8, 2uint8}" -> a struct of two scalars, so a schema can check each spelled type before any byte is placed.
export function parseInputFormat(inputFormat: string): InputFormatStruct {
    const t = (inputFormat ?? "").trim();
    return { kind: "struct", items: t ? expandReps(splitTop(t)).map(parseInputToken) : [], raw: t };
}

function parseInputToken(tok: string): InputFormatNode {
    tok = tok.trim();
    if (tok[0] === "{") {
        if (tok[tok.length - 1] !== "}") throw new Error(`struct value is missing its closing '}': '${tok}'`);
        return { kind: "struct", items: expandReps(splitTop(tok.slice(1, -1))).map(parseInputToken), raw: tok };
    }
    if (tok[0] === "[") {
        if (tok[tok.length - 1] !== "]") throw new Error(`array value is missing its closing ']': '${tok}'`);
        const inner = tok.slice(1, -1);
        const semi = inner.indexOf(";");
        const items = expandReps(splitTop(semi >= 0 ? inner.slice(semi + 1) : inner)).map(parseInputToken);
        let count: number | null = null;
        if (semi >= 0) {
            const rawCount = inner.slice(0, semi).trim();
            if (!/^\d+$/.test(rawCount)) throw new Error(`array count '${rawCount}' must be a non-negative integer`);
            count = parseInt(rawCount, 10);
            if (items.length !== count) throw new Error(`array of ${count} needs ${count} values, got ${items.length}`);
        }
        return { kind: "array", count, items, raw: tok };
    }
    const suffix = WIDE_SUFFIXES.find((candidate) => tok.endsWith(candidate));
    if (suffix) {
        return { kind: "scalar", type: suffix, text: tok.slice(0, -suffix.length).trim(), raw: tok };
    }
    const { numStr, type } = scalarToken(tok);
    return { kind: "scalar", type, text: numStr, raw: tok };
}

// Value text -> bytes checked against an entry's schema and written at its offsets, e.g. "1uint32" for a uint64 field is refused.
export async function encodeInputFormatAs(type: AbiType, inputFormat: string): Promise<Uint8Array> {
    const root = parseInputFormat(inputFormat);
    const node = type.kind === AbiTypeKind.STRUCT ? unwrapInputBraces(root, type) : root.items.length === 1 ? root.items[0] : root;
    const bytes = new Uint8Array(type.size);
    await writeInputNode(new DataView(bytes.buffer), 0, type, node, "input");
    return bytes;
}

// "{a, b}" and "a, b" both spell the input struct; only a one-field struct wrapping another struct keeps its braces.
function unwrapInputBraces(root: InputFormatStruct, type: AbiStruct): InputFormatNode {
    const only = root.items.length === 1 ? root.items[0] : null;
    if (only?.kind !== "struct") return root;
    return type.fields.length === 1 && type.fields[0].type.kind === AbiTypeKind.STRUCT ? root : only;
}

async function writeInputNode(view: DataView, offset: number, type: AbiType, node: InputFormatNode, path: string): Promise<void> {
    switch (type.kind) {
        case AbiTypeKind.SCALAR: {
            if (node.kind !== "scalar" || node.type !== type.scalar) {
                throw new Error(`${path} is ${type.scalar}, got '${node.raw}'`);
            }
            await encodeAbiScalar(view, offset, type.scalar, inputScalarValue(node));
            return;
        }
        case AbiTypeKind.STRUCT: {
            if (node.kind !== "struct") {
                throw new Error(`${path} is a struct ${formatAbiType(type)}, got '${node.raw}'`);
            }
            if (hasOverlappingFields(type)) {
                await writeRawInputNode(view, offset, type, node, path);
                return;
            }
            if (node.items.length !== type.fields.length) {
                throw new Error(`${path} has ${type.fields.length} field(s), got ${node.items.length} value(s)`);
            }
            for (let index = 0; index < type.fields.length; index++) {
                const field = type.fields[index];
                await writeInputNode(view, offset + field.offset, field.type, node.items[index], `${path}.${field.name}`);
            }
            return;
        }
        case AbiTypeKind.ARRAY: {
            if (node.kind !== "array") {
                throw new Error(`${path} is an array of ${type.count}, got '${node.raw}'`);
            }
            if (node.items.length !== type.count) {
                throw new Error(`${path} expects ${type.count} elements, got ${node.items.length}`);
            }
            const { stride } = arrayGeometry(type.element, type.count);
            for (let index = 0; index < type.count; index++) {
                await writeInputNode(view, offset + index * stride, type.element, node.items[index], `${path}[${index}]`);
            }
            return;
        }
        default:
            // Bit arrays are spelled as their physical words and containers have no value dialect, so those keep the spelling's bytes, checked only for size.
            await writeRawInputNode(view, offset, type, node, path);
    }
}

async function writeRawInputNode(view: DataView, offset: number, type: AbiType, node: InputFormatNode, path: string): Promise<void> {
    const out: number[] = [];
    await encodeToken(node.raw, out);
    if (out.length !== type.size) {
        throw new Error(`${path} encodes to ${out.length} bytes, ${formatAbiType(type)} wants ${type.size}`);
    }
    writeBytes(view, offset, new Uint8Array(out));
}

// The typed scalar writer takes the JSON spellings, where a zero id or m256i is spelled out in full.
function inputScalarValue(node: InputFormatNode & { kind: "scalar" }): string {
    if ((node.type === "id" || node.type === "m256i") && node.text === "0") return "0".repeat(64);
    return node.text;
}

// Throws unless the encoded bytes match the entry's size — the guard the schema-free path needs, since it never sees the schema and the engine would silently zero-fill or truncate.
export function assertInputSize(type: AbiType, bytes: Uint8Array, label: string): void {
    if (bytes.length === type.size) return;
    const shape = type.format ? ` (${type.format})` : " (no input)";
    throw new Error(`encodes to ${bytes.length} bytes, ${label} wants ${type.size}${shape}`);
}
