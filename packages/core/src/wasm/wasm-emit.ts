// Instruction emitter for the journal helpers. Branch targets are named and resolved from a label
// stack, because hand-counting `br` depths through nested blocks is where this kind of code goes wrong.
import { ByteWriter } from "./wasm-binary";

export const WasmType = {
    I32: 0x7f,
    I64: 0x7e,
    F32: 0x7d,
    F64: 0x7c,
} as const;

export type WasmTypeCode = (typeof WasmType)[keyof typeof WasmType];

export const Op = {
    BLOCK: 0x02,
    LOOP: 0x03,
    IF: 0x04,
    ELSE: 0x05,
    END: 0x0b,
    BR: 0x0c,
    BR_IF: 0x0d,
    RETURN: 0x0f,
    CALL: 0x10,
    DROP: 0x1a,
    LOCAL_GET: 0x20,
    LOCAL_SET: 0x21,
    LOCAL_TEE: 0x22,
    GLOBAL_GET: 0x23,
    GLOBAL_SET: 0x24,
    I32_LOAD: 0x28,
    I32_LOAD8_U: 0x2d,
    I32_STORE: 0x36,
    I32_CONST: 0x41,
    I32_EQZ: 0x45,
    I32_EQ: 0x46,
    I32_LT_U: 0x49,
    I32_GT_U: 0x4b,
    I32_GE_U: 0x4f,
    I32_ADD: 0x6a,
    I32_SUB: 0x6b,
    I32_MUL: 0x6c,
    I32_AND: 0x71,
    I32_OR: 0x72,
    I32_SHL: 0x74,
    I32_SHR_U: 0x76,
    UNREACHABLE: 0x00,
    PREFIX_FC: 0xfc,
} as const;

export const BULK_MEMORY_INIT = 8;
export const BULK_MEMORY_COPY = 10;
export const BULK_MEMORY_FILL = 11;

const EMPTY_BLOCK_TYPE = 0x40;

/** Emits a function body: locals vector, instructions, terminating `end`. */
export class CodeEmitter {
    private readonly writer = new ByteWriter();
    private readonly labels: string[] = [];

    constructor(private readonly localGroups: readonly { count: number; type: WasmTypeCode }[] = []) {}

    private depthOf(label: string): number {
        for (let index = this.labels.length - 1; index >= 0; index--) {
            if (this.labels[index] === label) {
                return this.labels.length - 1 - index;
            }
        }
        throw new Error(`branch target '${label}' is not open`);
    }

    op(opcode: number): this {
        this.writer.byte(opcode);
        return this;
    }

    u32(value: number): this {
        this.writer.u32(value);
        return this;
    }

    constI32(value: number): this {
        this.writer.byte(Op.I32_CONST).i32(value);
        return this;
    }

    localGet(index: number): this {
        return this.op(Op.LOCAL_GET).u32(index);
    }

    localSet(index: number): this {
        return this.op(Op.LOCAL_SET).u32(index);
    }

    localTee(index: number): this {
        return this.op(Op.LOCAL_TEE).u32(index);
    }

    globalGet(index: number): this {
        return this.op(Op.GLOBAL_GET).u32(index);
    }

    globalSet(index: number): this {
        return this.op(Op.GLOBAL_SET).u32(index);
    }

    call(index: number): this {
        return this.op(Op.CALL).u32(index);
    }

    /** `align` is the log2 alignment hint; 0 is always valid and never traps. */
    memory(opcode: number, offset = 0, align = 0): this {
        return this.op(opcode).u32(align).u32(offset);
    }

    bulk(subOpcode: number, ...immediates: number[]): this {
        this.op(Op.PREFIX_FC).u32(subOpcode);
        for (const immediate of immediates) {
            this.u32(immediate);
        }
        return this;
    }

    block(label: string, body: () => void): this {
        this.op(Op.BLOCK).op(EMPTY_BLOCK_TYPE);
        this.labels.push(label);
        body();
        this.labels.pop();
        return this.op(Op.END);
    }

    loop(label: string, body: () => void): this {
        this.op(Op.LOOP).op(EMPTY_BLOCK_TYPE);
        this.labels.push(label);
        body();
        this.labels.pop();
        return this.op(Op.END);
    }

    /** `if` opens an anonymous label, so nested branch depths stay correct. */
    if(body: () => void): this {
        this.op(Op.IF).op(EMPTY_BLOCK_TYPE);
        this.labels.push("");
        body();
        this.labels.pop();
        return this.op(Op.END);
    }

    br(label: string): this {
        return this.op(Op.BR).u32(this.depthOf(label));
    }

    brIf(label: string): this {
        return this.op(Op.BR_IF).u32(this.depthOf(label));
    }

    /** The complete body entry: locals vector, code, `end`, prefixed with its byte size. */
    finish(): Uint8Array {
        const bodyWriter = new ByteWriter();
        bodyWriter.u32(this.localGroups.length);
        for (const group of this.localGroups) {
            bodyWriter.u32(group.count).byte(group.type);
        }
        bodyWriter.bytes(this.writer.toBytes());
        bodyWriter.byte(Op.END);

        const encoded = bodyWriter.toBytes();
        return new ByteWriter().u32(encoded.length).bytes(encoded).toBytes();
    }
}

export function encodeFunctionType(params: readonly WasmTypeCode[], results: readonly WasmTypeCode[]): Uint8Array {
    const writer = new ByteWriter();
    writer.byte(0x60).u32(params.length);
    for (const param of params) {
        writer.byte(param);
    }
    writer.u32(results.length);
    for (const result of results) {
        writer.byte(result);
    }
    return writer.toBytes();
}

/** A mutable i32 global initialised to zero. */
export function encodeMutableI32Global(): Uint8Array {
    return new ByteWriter().byte(WasmType.I32).byte(0x01).byte(Op.I32_CONST).i32(0).byte(Op.END).toBytes();
}

export function encodeFunctionExport(name: string, functionIndex: number): Uint8Array {
    return new ByteWriter().name(name).byte(0x00).u32(functionIndex).toBytes();
}
