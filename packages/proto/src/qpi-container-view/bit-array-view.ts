import { AbiTypeKind, type AbiBitArray } from "../contract-idl";
import { bitArrayGeometry } from "../qpi-layout";
import { QpiIncompleteReadError } from "./errors";
import { readQpiBytes, type QpiByteSource } from "./source";

export interface QpiBitArrayEntry {
    index: number;
    value: 0 | 1;
}

export class QpiBitArrayView {
    readonly kind = AbiTypeKind.BIT_ARRAY;
    readonly capacity: number;

    constructor(
        readonly type: AbiBitArray,
        private readonly source: QpiByteSource,
    ) {
        this.capacity = type.bitCount;
        assertCapacity(type.bitCount);
        const geometry = bitArrayGeometry(type.bitCount);
        if (type.align !== geometry.align || type.size !== geometry.size) {
            throw new Error("BitArray ABI layout has an invalid size or alignment");
        }
        assertSource(source, type.size);
    }

    async get(index: number): Promise<0 | 1> {
        this.assertIndex(index);
        const byteOffset = Math.floor(index / 8);
        const bytes = await readQpiBytes(this.source, byteOffset, 1);
        return bitAt(bytes, index & 7);
    }

    async entries(): Promise<QpiBitArrayEntry[]> {
        const entries: QpiBitArrayEntry[] = [];
        const logicalBytes = Math.ceil(this.capacity / 8);
        let byteOffset = 0;
        while (byteOffset < logicalBytes) {
            const length = Math.min(this.source.maxReadLength, logicalBytes - byteOffset);
            const bytes = await readQpiBytes(this.source, byteOffset, length);
            const firstBit = byteOffset * 8;
            const bitCount = Math.min(bytes.length * 8, this.capacity - firstBit);
            for (let localBit = 0; localBit < bitCount; localBit++) {
                entries.push({
                    index: firstBit + localBit,
                    value: bitAt(bytes, localBit),
                });
            }
            byteOffset += length;
        }
        return entries;
    }

    async *setBits(): AsyncIterable<number> {
        const logicalBytes = Math.ceil(this.capacity / 8);
        let byteOffset = 0;
        while (byteOffset < logicalBytes) {
            const length = Math.min(this.source.maxReadLength, logicalBytes - byteOffset);
            const bytes = await readQpiBytes(this.source, byteOffset, length);
            const firstBit = byteOffset * 8;
            for (let localByte = 0; localByte < bytes.length; localByte++) {
                const value = bytes[localByte];
                if (!value) {
                    continue;
                }
                const byteFirstBit = firstBit + localByte * 8;
                const bitCount = Math.min(8, this.capacity - byteFirstBit);
                for (let bit = 0; bit < bitCount; bit++) {
                    if (value & (1 << bit)) {
                        yield byteFirstBit + bit;
                    }
                }
            }
            byteOffset += length;
        }
    }

    private assertIndex(index: number): void {
        if (!Number.isSafeInteger(index) || index < 0 || index >= this.capacity) {
            throw new RangeError(`BitArray index ${index} is outside 0..${this.capacity - 1}`);
        }
    }
}

function assertCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new Error("BitArray capacity must be a positive power of two");
    }
    const integer = BigInt(capacity);
    if ((integer & (integer - 1n)) !== 0n) {
        throw new Error("BitArray capacity must be a positive power of two");
    }
}

function assertSource(source: QpiByteSource, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("BitArray ABI has an invalid size");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
        throw new QpiIncompleteReadError(
            `BitArray needs ${size} bytes, source has ${source.byteLength}`,
        );
    }
    if (!Number.isSafeInteger(source.maxReadLength) || source.maxReadLength <= 0) {
        throw new Error("QPI byte source has an invalid maxReadLength");
    }
}

function bitAt(bytes: Uint8Array, index: number): 0 | 1 {
    return ((bytes[index >> 3] >> (index & 7)) & 1) as 0 | 1;
}
