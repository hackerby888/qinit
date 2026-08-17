// A 32-byte entity identity — qpi.h's `typedef m256i id`. An alias, like the typedef it ports.
export type Id = Uint8Array;

const ZERO_ID = new Uint8Array(32);

// Views a slice as a Buffer without copying, so comparisons run as native memcmp. Contract states reach
// hundreds of megabytes, where a per-byte loop costs ten times as much.
export function asBuffer(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }

    return asBuffer(a).equals(asBuffer(b));
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;

    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }

    return output;
}

export function first32BytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    for (let index = 0; index < 32; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
}

export function isZeroId(id: Id): boolean {
    return first32BytesEqual(id, ZERO_ID);
}
