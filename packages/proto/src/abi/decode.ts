// Bytes -> value, driven by either an AbiType or a type-format string.
import { bytesToIdentity, roundUp } from "@qinit/core";
import { AbiScalarKind, AbiTypeKind, type AbiType } from "../contract-idl";
import { createQpiContainerView } from "../qpi-container-view";
import { qpiBorrowedSource } from "../qpi-container-view/source";
import { alignOf, parseLayout, sizeOf, type TypeNode } from "./type-format";

// output decode (aligned; async: id -> 60-char identity)
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
        case "sint128": {
            const low = v.getBigUint64(off, true);
            const high = v.getBigUint64(off + 8, true);
            const value = (high << 64n) | low;
            return [value >= 1n << 127n ? value - (1n << 128n) : value, off + 16];
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

export async function decodeAbiType(view: DataView, offset: number, type: AbiType): Promise<any> {
    assertBounds(view, offset, type.size);

    switch (type.kind) {
        case AbiTypeKind.SCALAR:
            return decodeAbiScalar(view, offset, type.scalar);
        case AbiTypeKind.STRUCT:
            return await Promise.all(type.fields.map((field) => decodeAbiType(view, offset + field.offset, field.type)));
        case AbiTypeKind.ARRAY:
        case AbiTypeKind.BIT_ARRAY:
        case AbiTypeKind.HASH_MAP:
        case AbiTypeKind.HASH_SET:
        case AbiTypeKind.COLLECTION:
        case AbiTypeKind.LINKED_LIST:
            return await decodeAbiContainer(view, offset, type);
    }
}

async function decodeAbiContainer(
    view: DataView,
    offset: number,
    type: Extract<
        AbiType,
        {
            kind: AbiTypeKind.ARRAY | AbiTypeKind.BIT_ARRAY | AbiTypeKind.HASH_MAP | AbiTypeKind.HASH_SET | AbiTypeKind.COLLECTION | AbiTypeKind.LINKED_LIST;
        }
    >,
): Promise<any[]> {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, type.size);
    const container = createQpiContainerView(type, qpiBorrowedSource(bytes));
    switch (container.kind) {
        case AbiTypeKind.ARRAY:
        case AbiTypeKind.BIT_ARRAY:
            return (await container.entries()).map((entry) => entry.value);
        case AbiTypeKind.HASH_MAP:
        case AbiTypeKind.HASH_SET:
        case AbiTypeKind.COLLECTION:
        case AbiTypeKind.LINKED_LIST:
            return await container.entries();
    }
}

export async function decodeAbiScalar(view: DataView, offset: number, scalar: AbiScalarKind): Promise<any> {
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
                hex += view
                    .getUint8(offset + index)
                    .toString(16)
                    .padStart(2, "0");
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

// The format dialect reads field by field, so a layout wider than the bytes surfaces as the DataView's RangeError; name both sizes, as the typed path does.
async function decodeFormat(view: DataView, fmt: string): Promise<any> {
    const node = parseLayout(fmt);
    try {
        return (await decodeNode(view, 0, node))[0];
    } catch (error) {
        if (error instanceof RangeError) {
            throw new RangeError(`${fmt} reads ${sizeOf(node)} bytes, only ${view.byteLength} returned`);
        }
        throw error;
    }
}

export function assertBounds(view: DataView, offset: number, size: number): void {
    if (offset < 0 || size < 0 || offset + size > view.byteLength) {
        throw new RangeError(`ABI value at ${offset} with size ${size} exceeds ${view.byteLength} bytes`);
    }
}

export async function decodeOutput(bytes: Uint8Array, fmt: string | AbiType): Promise<any> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoded = typeof fmt === "string" ? await decodeFormat(view, fmt) : await decodeAbiValue(bytes, fmt);
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

// Decoded value -> JSON shape. Structs come back positional and are named here; scalars stay as decoded — bigint for 64/128-bit, identity text for id.
export function abiJsonValue(value: any, type: AbiType): unknown {
    switch (type.kind) {
        case AbiTypeKind.SCALAR:
        case AbiTypeKind.BIT_ARRAY:
            return value;
        case AbiTypeKind.STRUCT: {
            const values = Array.isArray(value) ? value : [value];
            const named: Record<string, unknown> = {};
            type.fields.forEach((field, index) => {
                named[field.name] = abiJsonValue(values[index], field.type);
            });
            return named;
        }
        case AbiTypeKind.ARRAY:
            return Array.isArray(value) ? value.map((item) => abiJsonValue(item, type.element)) : value;
        case AbiTypeKind.HASH_MAP:
            return Array.isArray(value)
                ? value.map((entry) => ({ ...entry, key: abiJsonValue(entry.key, type.key), value: abiJsonValue(entry.value, type.value) }))
                : value;
        case AbiTypeKind.HASH_SET:
            return Array.isArray(value) ? value.map((entry) => ({ ...entry, key: abiJsonValue(entry.key, type.key) })) : value;
        case AbiTypeKind.COLLECTION:
        case AbiTypeKind.LINKED_LIST:
            return Array.isArray(value) ? value.map((entry) => ({ ...entry, value: abiJsonValue(entry.value, type.value) })) : value;
    }
}

// The JSON shape of what decodeOutput returned, which already unwrapped a one-field struct to its value.
export function decodedJsonValue(value: any, type: AbiType): unknown {
    if (type.kind === AbiTypeKind.STRUCT && type.fields.length === 0) {
        return {};
    }
    if (type.kind === AbiTypeKind.STRUCT && type.fields.length === 1) {
        return abiJsonValue(value, type.fields[0].type);
    }
    return abiJsonValue(value, type);
}

export async function decodeAbiValue(bytes: Uint8Array, type: AbiType): Promise<any> {
    return await decodeAbiType(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, type);
}
