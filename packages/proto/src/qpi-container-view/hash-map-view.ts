import { decodeAbiValue } from "../abi-fmt";
import { AbiTypeKind, type AbiHashMap } from "../contract-idl";
import { hashMapGeometry } from "../qpi-layout";
import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
import { occupiedRanges, occupiedSlots, readQpiBytes, readUint64, type QpiByteSource } from "./source";

export interface QpiHashMapEntry {
    slot: number;
    key: unknown;
    value: unknown;
}

export class QpiHashMapView {
    readonly kind = AbiTypeKind.HASH_MAP;
    readonly capacity: number;

    private readonly geometry;

    constructor(
        readonly type: AbiHashMap,
        private readonly source: QpiByteSource,
    ) {
        this.capacity = type.capacity;
        assertCapacity(type.capacity);
        this.geometry = hashMapGeometry(type.key, type.value, type.capacity);
        if (type.align !== this.geometry.align || type.size !== this.geometry.size) {
            throw new Error("HashMap ABI layout has an invalid size or alignment");
        }
        assertSource(source, type.size);
    }

    async entries(): Promise<QpiHashMapEntry[]> {
        const population = populationOf(await readUint64(this.source, this.geometry.populationOffset), this.capacity);
        if (!population) {
            return [];
        }

        const flags = await readQpiBytes(this.source, this.geometry.flagsOffset, this.geometry.flagsBytes);
        const slots = occupiedSlots(flags, this.capacity);
        if (slots.length !== population) {
            throw new QpiContainerConsistencyError(`HashMap has ${slots.length} occupied slots but population ${population}`);
        }

        const entries: QpiHashMapEntry[] = [];
        for (const range of occupiedRanges(slots)) {
            const count = range.end - range.start + 1;
            const bytes = await readQpiBytes(this.source, range.start * this.geometry.recordStride, count * this.geometry.recordStride);
            for (let index = 0; index < count; index++) {
                const slot = range.start + index;
                const offset = index * this.geometry.recordStride;
                entries.push({
                    slot,
                    key: await decodeAbiValue(bytes.slice(offset, offset + this.type.key.size), this.type.key),
                    value: await decodeAbiValue(
                        bytes.slice(offset + this.geometry.valueOffset, offset + this.geometry.valueOffset + this.type.value.size),
                        this.type.value,
                    ),
                });
            }
        }
        return entries;
    }
}

function assertCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new Error("HashMap capacity must be a positive power of two");
    }
    const integer = BigInt(capacity);
    if ((integer & (integer - 1n)) !== 0n) {
        throw new Error("HashMap capacity must be a positive power of two");
    }
}

function assertSource(source: QpiByteSource, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("HashMap ABI has an invalid size");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
        throw new QpiIncompleteReadError(`HashMap needs ${size} bytes, source has ${source.byteLength}`);
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
