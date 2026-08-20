import { decodeAbiValue } from "../abi-fmt";
import { AbiTypeKind, type AbiHashSet } from "../contract-idl";
import { hashSetGeometry } from "../qpi-layout";
import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
import { occupiedRanges, occupiedSlots, readQpiBytes, readUint64, type QpiByteSource } from "./source";

export interface QpiHashSetEntry {
    slot: number;
    key: unknown;
}

export class QpiHashSetView {
    readonly kind = AbiTypeKind.HASH_SET;
    readonly capacity: number;

    private readonly geometry;

    constructor(
        readonly type: AbiHashSet,
        private readonly source: QpiByteSource,
    ) {
        this.capacity = type.capacity;
        assertCapacity(type.capacity);
        this.geometry = hashSetGeometry(type.key, type.capacity);
        if (type.align !== this.geometry.align || type.size !== this.geometry.size) {
            throw new Error("HashSet ABI layout has an invalid size or alignment");
        }
        assertSource(source, type.size);
    }

    async entries(): Promise<QpiHashSetEntry[]> {
        const population = populationOf(await readUint64(this.source, this.geometry.populationOffset), this.capacity);
        if (!population) {
            return [];
        }

        const flags = await readQpiBytes(this.source, this.geometry.flagsOffset, this.geometry.flagsBytes);
        const slots = occupiedSlots(flags, this.capacity);
        if (slots.length !== population) {
            throw new QpiContainerConsistencyError(`HashSet has ${slots.length} occupied slots but population ${population}`);
        }

        const entries: QpiHashSetEntry[] = [];
        for (const range of occupiedRanges(slots)) {
            const count = range.end - range.start + 1;
            const bytes = await readQpiBytes(this.source, range.start * this.geometry.recordStride, count * this.geometry.recordStride);
            for (let index = 0; index < count; index++) {
                const slot = range.start + index;
                const offset = index * this.geometry.recordStride;
                entries.push({
                    slot,
                    key: await decodeAbiValue(bytes.slice(offset, offset + this.type.key.size), this.type.key),
                });
            }
        }
        return entries;
    }
}

function assertCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new Error("HashSet capacity must be a positive power of two");
    }
    const integer = BigInt(capacity);
    if ((integer & (integer - 1n)) !== 0n) {
        throw new Error("HashSet capacity must be a positive power of two");
    }
}

function assertSource(source: QpiByteSource, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("HashSet ABI has an invalid size");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
        throw new QpiIncompleteReadError(`HashSet needs ${size} bytes, source has ${source.byteLength}`);
    }
    if (!Number.isSafeInteger(source.maxReadLength) || source.maxReadLength <= 0) {
        throw new Error("QPI byte source has an invalid maxReadLength");
    }
}

function populationOf(population: bigint, capacity: number): number {
    if (population > BigInt(capacity)) {
        throw new QpiContainerConsistencyError(`container population ${population} exceeds capacity ${capacity}`);
    }
    return Number(population);
}
