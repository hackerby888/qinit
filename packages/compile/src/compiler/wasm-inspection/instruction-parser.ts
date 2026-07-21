import { Reader, WasmParseError, error } from "./binary-reader";
import type { InternalGlobal, ParsedModule } from "./parsed-module";
import type { WasmValueType } from "./inspection-types";

export function readValueType(reader: Reader, parsed: ParsedModule, context: string): WasmValueType {
    const at = reader.pos;
    switch (reader.byte(`${context} value type`)) {
        case 0x7f:
            return "i32";
        case 0x7e:
            return "i64";
        case 0x7d:
            return "f32";
        case 0x7c:
            return "f64";
        case 0x7b:
            parsed.features.add("simd");
            throw new WasmParseError(`${context} uses v128`, at);
        case 0x70:
        case 0x6f:
            parsed.features.add("reference-types");
            throw new WasmParseError(`${context} uses a reference value type`, at);
        default:
            throw new WasmParseError(`${context} has an unknown value type`, at);
    }
}

export function readValueTypeVector(reader: Reader, parsed: ParsedModule, context: string): WasmValueType[] {
    const count = reader.u32(`${context} count`);
    const values: WasmValueType[] = [];
    for (let index = 0; index < count; index++)
        values.push(readValueType(reader, parsed, context));
    return values;
}

export function readLimits(reader: Reader, parsed: ParsedModule, context: "memory" | "table"): {
    minimum: bigint;
    maximum?: bigint;
    shared: boolean;
    memory64: boolean;
} {
    const at = reader.pos;
    const flags = reader.u32(`${context} limits flags`);
    const shared = (flags & 0x02) !== 0;
    const memory64 = context === "memory" && (flags & 0x04) !== 0;
    const hasMaximum = (flags & 0x01) !== 0;
    if (shared)
        parsed.features.add("threads/shared-memory");
    if (memory64)
        parsed.features.add("memory64");
    const known = context === "memory" ? 0x07 : 0x01;
    if ((flags & ~known) !== 0)
        throw new WasmParseError(`${context} has unsupported limits flags 0x${flags.toString(16)}`, at);
    const readLimit = () => memory64 ? reader.u64(`${context} limit`) : BigInt(reader.u32(`${context} limit`));
    const minimum = readLimit();
    const maximum = hasMaximum ? readLimit() : undefined;
    return { minimum, maximum, shared, memory64 };
}

export function readTableType(reader: Reader, parsed: ParsedModule): void {
    const at = reader.pos;
    const elementType = reader.byte("table element type");
    // 0x70 was anyfunc in MVP and is funcref in the reference-types spelling.
    if (elementType !== 0x70) {
        parsed.features.add("reference-types");
        if (elementType !== 0x6f)
            throw new WasmParseError("table has an unsupported element type", at);
    }
    readLimits(reader, parsed, "table");
}

export function readGlobalType(reader: Reader, parsed: ParsedModule): InternalGlobal {
    const type = readValueType(reader, parsed, "global");
    const at = reader.pos;
    const mutable = reader.byte("global mutability");
    if (mutable !== 0 && mutable !== 1)
        throw new WasmParseError("global mutability must be 0 or 1", at);
    return { type, mutable: mutable === 1 };
}

export function readConstExpression(reader: Reader, parsed: ParsedModule): void {
    const opcodeAt = reader.pos;
    switch (reader.byte("constant-expression opcode")) {
        case 0x23:
            reader.u32("global.get index");
            break;
        case 0x41:
            reader.signedLeb(5, "i32.const");
            break;
        case 0x42:
            reader.signedLeb(10, "i64.const");
            break;
        case 0x43:
            reader.skip(4, "f32.const");
            break;
        case 0x44:
            reader.skip(8, "f64.const");
            break;
        case 0xd0:
        case 0xd2:
            parsed.features.add("reference-types");
            throw new WasmParseError("constant expression uses reference types", opcodeAt);
        default:
            parsed.features.add("extended-constant-expressions");
            throw new WasmParseError("constant expression is outside the MVP subset", opcodeAt);
    }
    if (reader.byte("constant-expression end") !== 0x0b) {
        parsed.features.add("extended-constant-expressions");
        throw new WasmParseError("constant expression has more than one instruction", reader.pos - 1);
    }
}

export function readBlockType(reader: Reader, parsed: ParsedModule): void {
    const at = reader.pos;
    const first = reader.byte("block type");
    if (first === 0x40 || first === 0x7f || first === 0x7e || first === 0x7d || first === 0x7c)
        return;
    parsed.features.add("multi-value/block-type-index");
    for (let index = 1; index < 5 && (first & 0x80) !== 0; index++) {
        if ((reader.byte("block type index") & 0x80) === 0)
            return;
    }
    if ((first & 0x80) !== 0)
        throw new WasmParseError("invalid block type index", at);
}

/** Returns false when an unsupported prefix makes the rest of this body opaque. */
export function readInstruction(reader: Reader, parsed: ParsedModule): boolean {
    const at = reader.pos;
    const opcode = reader.byte("opcode");
    switch (opcode) {
        case 0x00:
        case 0x01:
        case 0x05:
        case 0x0b:
        case 0x0f:
        case 0x1a:
        case 0x1b:
            return true;
        case 0x02:
        case 0x03:
        case 0x04:
            readBlockType(reader, parsed);
            return true;
        case 0x0c:
        case 0x0d:
        case 0x10:
        case 0x20:
        case 0x21:
        case 0x22:
        case 0x23:
        case 0x24:
            reader.u32("instruction index");
            return true;
        case 0x0e: {
            const count = reader.u32("br_table target count");
            for (let index = 0; index <= count; index++)
                reader.u32("br_table target");
            return true;
        }
        case 0x11: {
            reader.u32("call_indirect type index");
            const table = reader.u32("call_indirect table index");
            if (table !== 0)
                parsed.features.add("multiple-tables");
            return true;
        }
        case 0x25:
        case 0x26:
            parsed.features.add("reference-types/table-instructions");
            reader.u32("table index");
            return true;
        case 0x3f:
        case 0x40: {
            const memory = reader.u32("memory index");
            if (memory !== 0)
                parsed.features.add("multiple-memories");
            return true;
        }
        case 0x41:
            reader.signedLeb(5, "i32.const");
            return true;
        case 0x42:
            reader.signedLeb(10, "i64.const");
            return true;
        case 0x43:
            reader.skip(4, "f32.const");
            return true;
        case 0x44:
            reader.skip(8, "f64.const");
            return true;
        case 0x12:
            parsed.features.add("tail-calls");
            reader.u32("return_call function index");
            return true;
        case 0x13:
            parsed.features.add("tail-calls");
            reader.u32("return_call_indirect type index");
            reader.u32("return_call_indirect table index");
            return true;
        case 0x14:
        case 0x15:
            parsed.features.add("typed-function-references/tail-calls");
            reader.u32("call_ref type index");
            return true;
        case 0x1c: {
            parsed.features.add("typed-select");
            const count = reader.u32("typed select type count");
            for (let index = 0; index < count; index++)
                readValueType(reader, parsed, "typed select");
            return true;
        }
        case 0xc0:
        case 0xc1:
        case 0xc2:
        case 0xc3:
        case 0xc4:
            parsed.features.add("sign-extension-operators");
            return true;
        case 0xd0:
            parsed.features.add("reference-types");
            reader.signedLeb(5, "heap type");
            return true;
        case 0xd1:
            parsed.features.add("reference-types");
            return true;
        case 0xd2:
            parsed.features.add("reference-types");
            reader.u32("ref.func function index");
            return true;
        case 0xfc: {
            const sub = reader.u32("0xfc subopcode");
            if (sub <= 7) {
                parsed.features.add("nontrapping-float-to-int");
                return true;
            }
            parsed.features.add("bulk-memory");
            if (sub === 8) {
                reader.u32("data index");
                reader.u32("memory index");
                return true;
            }
            if (sub === 9 || (sub >= 15 && sub <= 17)) {
                reader.u32("segment/table index");
                return true;
            }
            if (sub === 10 || sub === 12 || sub === 14) {
                reader.u32("first index");
                reader.u32("second index");
                return true;
            }
            if (sub === 11 || sub === 13) {
                reader.u32("memory/element index");
                return true;
            }
            return false;
        }
        case 0x06:
        case 0x07:
        case 0x08:
        case 0x09:
        case 0x18:
        case 0x19:
        case 0x1f:
            parsed.features.add("exception-handling");
            return false;
        case 0xfb:
            parsed.features.add("gc");
            return false;
        case 0xfd:
            parsed.features.add("simd");
            return false;
        case 0xfe:
            parsed.features.add("threads/atomics");
            return false;
        default:
            if (opcode >= 0x28 && opcode <= 0x3e) {
                const alignment = reader.u32("memory alignment");
                if (alignment >= 64) {
                    parsed.features.add("multiple-memories/memarg-extension");
                    return false;
                }
                reader.u32("memory offset");
                return true;
            }
            if (opcode >= 0x45 && opcode <= 0xbf)
                return true;
            parsed.features.add(`unknown-opcode-0x${opcode.toString(16).padStart(2, "0")}`);
            error(parsed.diagnostics, "unsupported-opcode", `opcode 0x${opcode.toString(16).padStart(2, "0")} is outside the portable MVP profile`, at);
            return false;
    }
}
