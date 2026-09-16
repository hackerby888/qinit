import { decodeAbiValue } from "../abi/decode";
import { AbiTypeKind, type AbiHashMap } from "../contract-idl";
import { hashMapGeometry } from "../qpi-layout";
import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
import { occupiedRanges, occupiedSlotIndices, readQpiBytes, readUint64, type QpiByteSource } from "./source";

export interface QpiHashMapEntry {
    elementIndex: number;
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
        // Flags read before the empty shortcut: population 0 over occupied slots is an inconsistency, not empty.
        const flags = await readQpiBytes(this.source, this.geometry.flagsOffset, this.geometry.flagsBytes);
        const occupied = occupiedSlotIndices(flags, this.capacity);
        if (occupied.length !== population) {
            throw new QpiContainerConsistencyError(`HashMap has ${occupied.length} occupied slots but population ${population}`);
        }
        if (!population) {
            return [];
        }

        const entries: QpiHashMapEntry[] = [];
        for (const range of occupiedRanges(occupied)) {
            const count = range.end - range.start + 1;
            const bytes = await readQpiBytes(this.source, range.start * this.geometry.elementStride, count * this.geometry.elementStride);
            for (let index = 0; index < count; index++) {
                const elementIndex = range.start + index;
                const offset = index * this.geometry.elementStride;
                entries.push({
                    elementIndex,
                    key: await decodeAbiValue(bytes.slice(offset, offset + this.type.key.size), this.type.key),
                    value: await decodeAbiValue(
                        bytes.slice(offset + this.geometry.elementValueOffset, offset + this.geometry.elementValueOffset + this.type.value.size),
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
