// A 32-byte entity identity — qpi.h's `typedef m256i id`. An alias, like the typedef it ports.
export type Id = Uint8Array;

const ZERO_ID = new Uint8Array(32);

// Views a slice as a Buffer without copying, so comparisons run as native memcmp. Contract states reach
// hundreds of megabytes, where a per-byte loop costs ten times as much.
function asBuffer(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

// Every state and journal diff funnels through here. Buffer.compare is a native memcmp where it exists;
// the browser (the IDE runs the engine in a worker) has no Buffer, so it falls back to a DataView walk.
export function rangesEqual(a: Uint8Array, aStart: number, b: Uint8Array, bStart: number, length: number): boolean {
    if (typeof Buffer !== "undefined") {
        // compare(target, targetStart, targetEnd, sourceStart, sourceEnd) — target is `b`, source is `a`.
        return asBuffer(a).compare(asBuffer(b), bStart, bStart + length, aStart, aStart + length) === 0;
    }

    const aView = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const bView = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let index = 0;

    // Four bytes a step; DataView tolerates the unaligned offsets these callers pass.
    for (; index + 4 <= length; index += 4) {
        if (aView.getUint32(aStart + index, true) !== bView.getUint32(bStart + index, true)) {
            return false;
        }
    }

    for (; index < length; index++) {
        if (a[aStart + index] !== b[bStart + index]) {
            return false;
        }
    }

    return true;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }

    return rangesEqual(a, 0, b, 0, a.length);
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
