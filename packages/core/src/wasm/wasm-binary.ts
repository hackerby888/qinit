// Minimal LEB128 and section primitives for rewriting a contract module. The compiler's
// `wasm-inspection` reader is read-only; this side has to emit too, so it keeps its own codec.

export const WASM_MAGIC = Object.freeze([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export const WasmSectionId = {
    CUSTOM: 0,
    TYPE: 1,
    IMPORT: 2,
    FUNCTION: 3,
    TABLE: 4,
    MEMORY: 5,
    GLOBAL: 6,
    EXPORT: 7,
    START: 8,
    ELEMENT: 9,
    CODE: 10,
    DATA: 11,
    DATA_COUNT: 12,
} as const;

export class WasmBinaryError extends Error {
    constructor(
        message: string,
        readonly offset?: number,
    ) {
        super(message);
        this.name = "WasmBinaryError";
    }
}

export interface WasmSection {
    readonly id: number;
    payload: Uint8Array;
}

/** Cursor over a byte range, decoding the LEB forms the wasm binary format uses. */
export class ByteReader {
    position = 0;

    constructor(readonly bytes: Uint8Array) {}

    get done(): boolean {
        return this.position >= this.bytes.length;
    }

    get remaining(): number {
        return this.bytes.length - this.position;
    }

    byte(context: string): number {
        if (this.position >= this.bytes.length) {
            throw new WasmBinaryError(`${context} ran past the end`, this.position);
        }
        return this.bytes[this.position++]!;
    }

    peek(): number {
        return this.bytes[this.position] ?? -1;
    }

    u32(context: string): number {
        let result = 0;
        let shift = 0;
        for (let index = 0; index < 5; index++) {
            const byte = this.byte(context);
            result |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                return result >>> 0;
            }
            shift += 7;
        }
        throw new WasmBinaryError(`${context} is not a 32-bit LEB`, this.position);
    }

    i32(context: string): number {
        let result = 0;
        let shift = 0;
        for (let index = 0; index < 5; index++) {
            const byte = this.byte(context);
            result |= (byte & 0x7f) << shift;
            shift += 7;
            if ((byte & 0x80) === 0) {
                if (shift < 32 && (byte & 0x40) !== 0) {
                    result |= -(1 << shift);
                }
                return result | 0;
            }
        }
        throw new WasmBinaryError(`${context} is not a signed 32-bit LEB`, this.position);
    }

    skipI64(context: string): void {
        for (let index = 0; index < 10; index++) {
            if ((this.byte(context) & 0x80) === 0) {
                return;
            }
        }
        throw new WasmBinaryError(`${context} is not a signed 64-bit LEB`, this.position);
    }

    skip(count: number, context: string): void {
        if (this.position + count > this.bytes.length) {
            throw new WasmBinaryError(`${context} ran past the end`, this.position);
        }
        this.position += count;
    }

    take(count: number, context: string): Uint8Array {
        const start = this.position;
        this.skip(count, context);
        return this.bytes.subarray(start, this.position);
    }

    name(context: string): string {
        return new TextDecoder().decode(this.take(this.u32(`${context} length`), context));
    }
}

/** Growable byte sink with the LEB and vector helpers the emitter needs. */
export class ByteWriter {
    private buffer: number[] = [];

    get length(): number {
        return this.buffer.length;
    }

    byte(value: number): this {
        this.buffer.push(value & 0xff);
        return this;
    }

    bytes(values: ArrayLike<number>): this {
        for (let index = 0; index < values.length; index++) {
            this.buffer.push(values[index]! & 0xff);
        }
        return this;
    }

    u32(value: number): this {
        let rest = value >>> 0;
        do {
            const byte = rest & 0x7f;
            rest >>>= 7;
            this.buffer.push(rest === 0 ? byte : byte | 0x80);
        } while (rest !== 0);
        return this;
    }

    i32(value: number): this {
        let rest = value | 0;
        for (;;) {
            const byte = rest & 0x7f;
            rest >>= 7;
            const signBit = (byte & 0x40) !== 0;
            if ((rest === 0 && !signBit) || (rest === -1 && signBit)) {
                this.buffer.push(byte);
                return this;
            }
            this.buffer.push(byte | 0x80);
        }
    }

    name(value: string): this {
        const encoded = new TextEncoder().encode(value);
        this.u32(encoded.length);
        return this.bytes(encoded);
    }

    // ArrayBuffer-backed, so the result is a valid BufferSource for WebAssembly.
    toBytes(): Uint8Array<ArrayBuffer> {
        return Uint8Array.from(this.buffer);
    }
}

export function encodeU32(value: number): Uint8Array<ArrayBuffer> {
    return new ByteWriter().u32(value).toBytes();
}

/** Splits a module into its sections, keeping order and custom sections intact. */
export function splitSections(wasm: Uint8Array): WasmSection[] {
    for (let index = 0; index < WASM_MAGIC.length; index++) {
        if (wasm[index] !== WASM_MAGIC[index]) {
            throw new WasmBinaryError("not a wasm module (bad magic or version)", index);
        }
    }

    const reader = new ByteReader(wasm);
    reader.skip(WASM_MAGIC.length, "module header");

    const sections: WasmSection[] = [];
    while (!reader.done) {
        const id = reader.byte("section id");
        const size = reader.u32("section size");
        sections.push({ id, payload: reader.take(size, "section payload") });
    }

    return sections;
}

export function joinSections(sections: readonly WasmSection[]): Uint8Array<ArrayBuffer> {
    const writer = new ByteWriter();
    writer.bytes(WASM_MAGIC);
    for (const section of sections) {
        writer.byte(section.id);
        writer.u32(section.payload.length);
        writer.bytes(section.payload);
    }
    return writer.toBytes();
}

/** Re-encodes a vector section from already-encoded elements. */
export function encodeVector(elements: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const writer = new ByteWriter();
    writer.u32(elements.length);
    for (const element of elements) {
        writer.bytes(element);
    }
    return writer.toBytes();
}

/** Splits a vector section payload into its raw elements, given a per-element reader. */
export function decodeVector(payload: Uint8Array, readElement: (reader: ByteReader) => void): Uint8Array[] {
    const reader = new ByteReader(payload);
    const count = reader.u32("vector count");
    const elements: Uint8Array[] = [];

    for (let index = 0; index < count; index++) {
        const start = reader.position;
        readElement(reader);
        elements.push(payload.subarray(start, reader.position));
    }

    return elements;
}
