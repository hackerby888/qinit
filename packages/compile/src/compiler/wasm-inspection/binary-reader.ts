import type { WasmInspectionDiagnostic } from "./inspection-types";

export class WasmParseError extends Error {
    constructor(message: string, readonly offset: number) {
        super(message);
    }
}

export class Reader {
    pos: number;
    constructor(readonly bytes: Uint8Array, start = 0, readonly end = bytes.byteLength) {
        this.pos = start;
        if (start < 0 || end < start || end > bytes.byteLength)
            throw new WasmParseError("invalid reader bounds", start);
    }
    get done(): boolean {
        return this.pos === this.end;
    }
    get remaining(): number {
        return this.end - this.pos;
    }
    byte(label = "byte"): number {
        if (this.pos >= this.end)
            throw new WasmParseError(`unexpected end while reading ${label}`, this.pos);
        return this.bytes[this.pos++];
    }
    skip(length: number, label = "bytes"): void {
        if (!Number.isSafeInteger(length) || length < 0 || this.pos + length > this.end) {
            throw new WasmParseError(`unexpected end while reading ${label}`, this.pos);
        }
        this.pos += length;
    }
    u32(label = "u32"): number {
        let value = 0;
        for (let index = 0; index < 5; index++) {
            const at = this.pos;
            const templateBindings = this.byte(label);
            if (index === 4 && (templateBindings & 0xf0) !== 0)
                throw new WasmParseError(`${label} exceeds uint32`, at);
            value += (templateBindings & 0x7f) * 2 ** (index * 7);
            if ((templateBindings & 0x80) === 0)
                return value >>> 0;
        }
        throw new WasmParseError(`${label} has an overlong LEB128 encoding`, this.pos);
    }
    u64(label = "u64"): bigint {
        let value = 0n;
        for (let index = 0; index < 10; index++) {
            const at = this.pos;
            const templateBindings = this.byte(label);
            if (index === 9 && (templateBindings & 0xfe) !== 0)
                throw new WasmParseError(`${label} exceeds uint64`, at);
            value |= BigInt(templateBindings & 0x7f) << BigInt(index * 7);
            if ((templateBindings & 0x80) === 0)
                return value;
        }
        throw new WasmParseError(`${label} has an overlong LEB128 encoding`, this.pos);
    }
    signedLeb(maxBytes: number, label: string): void {
        for (let index = 0; index < maxBytes; index++) {
            if ((this.byte(label) & 0x80) === 0)
                return;
        }
        throw new WasmParseError(`${label} has an overlong LEB128 encoding`, this.pos);
    }
    name(label = "name"): string {
        const length = this.u32(`${label} length`);
        const start = this.pos;
        this.skip(length, label);
        try {
            return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes.subarray(start, start + length));
        }
        catch {
            throw new WasmParseError(`${label} is not valid UTF-8`, start);
        }
    }
    subReader(length: number, label: string): Reader {
        const start = this.pos;
        this.skip(length, label);
        return new Reader(this.bytes, start, start + length);
    }
}

export function error(diagnostics: WasmInspectionDiagnostic[], code: string, message: string, offset?: number): void {
    diagnostics.push(offset === undefined
        ? { severity: "error", code, message }
        : { severity: "error", code, message, offset });
}
