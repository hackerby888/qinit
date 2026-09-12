// The ABI type grammar (qubic-cli compatible): uint8/16/32/64, sint8/16/32/64, id, bit; struct { t, t }; array [N; elem].
import { roundUp } from "@qinit/core";
import { AbiTypeKind, formatAbiType, type AbiStruct, type AbiType } from "../contract-idl";

export const SCALAR_SIZE: Record<string, number> = {
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
    | { kind: "sint128" }
    | { kind: "id" }
    | { kind: "bytes"; size: number } // m256i as raw hex (a digest, NOT an identity)
    | { kind: "array"; count: number; elem: TypeNode }
    | { kind: "struct"; fields: TypeNode[] };

export function alignOf(n: TypeNode): number {
    switch (n.kind) {
        case "scalar":
            return n.size;
        case "uint128":
        case "sint128":
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

export function sizeOf(n: TypeNode): number {
    switch (n.kind) {
        case "scalar":
            return n.size;
        case "uint128":
        case "sint128":
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

// Byte offset + size of each top-level field of a layout, mapping a changed state byte offset back to a field name for the debugger's state diff.
export function structFieldOffsets(fmt: string | AbiStruct): { off: number; size: number }[] {
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

export function nodeOf(type: AbiType): TypeNode {
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

// type-grammar parser (output layout / decode schema)
function parseType(s: string, i: number): [TypeNode, number] {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === "{") {
        i++;
        const fields: TypeNode[] = [];
        const skipSpace = () => {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (i >= s.length) throw new Error("struct is missing its closing '}'");
        };
        while (true) {
            skipSpace();
            // A separator is required between fields, so a dropped ',' is an error rather than a shorter struct; one trailing ',' stays legal.
            if (fields.length && s[i] !== "}") {
                if (s[i] !== ",") throw new Error(`struct fields are separated by ',' (got '${s[i]}' at position ${i})`);
                i++;
                skipSpace();
            }
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
        if (semi < 0) throw new Error("array needs a ';' between its count and element type");
        const rawCount = s.slice(i, semi).trim();
        if (!/^\d+$/.test(rawCount)) throw new Error(`array count '${rawCount}' must be a non-negative integer`);
        const count = parseInt(rawCount, 10);
        const [elem, ni] = parseType(s, semi + 1);
        i = ni;
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] !== "]") throw new Error("array is missing its closing ']'");
        i++;
        return [{ kind: "array", count, elem }, i];
    }
    let j = i;
    while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
    const tok = s.slice(i, j);
    if (!tok) throw new Error(`expected a type at position ${i}`);
    if (tok === "id") return [{ kind: "id" }, j];
    if (tok === "m256i") return [{ kind: "bytes", size: 32 }, j]; // m256i raw hex (vs id = identity)
    if (tok === "uint128") return [{ kind: "uint128" }, j];
    if (tok === "sint128") return [{ kind: "sint128" }, j];
    const size = SCALAR_SIZE[tok];
    if (!size) throw new Error(`unknown type '${tok}'`);
    return [{ kind: "scalar", type: tok, size, signed: tok.startsWith("sint"), big: size === 8 }, j];
}

export // Split by top-level commas, respecting [] and {} nesting.
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
    const trimmed = parts.map((x) => x.trim());
    // One trailing ',' is allowed, so only the last entry may be empty — anything else is a doubled or leading separator, read otherwise as a shorter list.
    for (let k = 0; k < trimmed.length - 1; k++) {
        if (!trimmed[k]) throw new Error(`empty entry between ',' separators at position ${k}`);
    }
    return trimmed.filter((x) => x.length);
}

export function parseLayout(fmt: string): TypeNode {
    const t = fmt.trim();
    if (!t) return { kind: "struct", fields: [] };
    const parts = splitTop(t); // top-level list: 1 -> that node; >1 -> implicit struct (symmetric with encode)
    // parseType stops at the end of one type, so leftover text is another field the caller meant — dropping it would read a missing ',' as a shorter layout.
    const one = (p: string): TypeNode => {
        const [node, end] = parseType(p, 0);
        const rest = p.slice(end).trim();
        if (rest) throw new Error(`unexpected '${rest}' after the type (fields are separated by ',')`);
        return node;
    };
    if (parts.length === 1) return one(parts[0]);
    return { kind: "struct", fields: parts.map(one) };
}

export function hasOverlappingFields(type: AbiStruct): boolean {
    for (let index = 0; index < type.fields.length; index++) {
        const field = type.fields[index];
        for (let previousIndex = 0; previousIndex < index; previousIndex++) {
            const previous = type.fields[previousIndex];
            if (field.size > 0 && previous.size > 0 && field.offset < previous.offset + previous.size && previous.offset < field.offset + field.size) {
                return true;
            }
        }
    }
    return false;
}

export function hasOverlappingAbiType(type: AbiType): boolean {
    switch (type.kind) {
        case AbiTypeKind.SCALAR:
            return false;
        case AbiTypeKind.STRUCT:
            return hasOverlappingFields(type) || type.fields.some((field) => hasOverlappingAbiType(field.type));
        case AbiTypeKind.ARRAY:
            return hasOverlappingAbiType(type.element);
        case AbiTypeKind.BIT_ARRAY:
            return false;
        case AbiTypeKind.COLLECTION:
            return hasOverlappingAbiType(type.value);
        case AbiTypeKind.HASH_MAP:
            return hasOverlappingAbiType(type.key) || hasOverlappingAbiType(type.value);
        case AbiTypeKind.HASH_SET:
            return hasOverlappingAbiType(type.key);
        case AbiTypeKind.LINKED_LIST:
            return hasOverlappingAbiType(type.value);
    }
}
