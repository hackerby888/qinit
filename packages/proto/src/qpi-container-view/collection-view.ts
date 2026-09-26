import { decodeAbiValue } from "../abi/decode";
import { AbiScalarKind, AbiTypeKind, type AbiCollection, type AbiScalar } from "../contract-idl";
import { collectionGeometry } from "../qpi-layout";
import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
import { occupiedRanges, occupiedSlotIndices, readQpiBytes, readUint64, sint64At, uint64At, type QpiByteSource } from "./source";

const NULL_INDEX = -1n;
// a pov is keyed by id whatever T is
const POV_TYPE: AbiScalar = {
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.ID,
    size: 32,
    align: 8,
    format: "id",
};

// e.g. { povIndex: 1, elementIndex: 0, pov: "FXHS…", priority: 5n, value: 7n }; two indices since _povs and _elements are separate slot runs
export interface QpiCollectionEntry {
    povIndex: number;
    elementIndex: number;
    pov: unknown;
    priority: bigint;
    value: unknown;
}

// core: struct PoV { id value; uint64 population; sint64 headIndex, tailIndex; sint64 bstRootIndex; }
interface CollectionPov {
    povIndex: number;
    value: unknown;
    population: number;
    headIndex: bigint;
    tailIndex: bigint;
    bstRootIndex: bigint;
}

// core: struct Element { T value; sint64 priority; sint64 povIndex; sint64 bstParentIndex; sint64 bstLeftIndex; sint64 bstRightIndex; }
interface CollectionElement {
    priority: bigint;
    povIndex: bigint;
    bstParentIndex: bigint;
    bstLeftIndex: bigint;
    bstRightIndex: bigint;
}

// reads _population, the pov flags, the occupied _povs, then _elements 0..population-1 in one read; each pov's elements come out in bst order
export class QpiCollectionView {
    readonly kind = AbiTypeKind.COLLECTION;
    readonly capacity: number;

    private readonly geometry;

    constructor(
        readonly type: AbiCollection,
        private readonly source: QpiByteSource,
    ) {
        this.capacity = type.capacity;
        assertCapacity(type.capacity);
        this.geometry = collectionGeometry(type.value, type.capacity);
        if (type.align !== this.geometry.align || type.size !== this.geometry.size) {
            throw new Error("Collection ABI layout has an invalid size or alignment");
        }
        assertSource(source, type.size);
    }

    // e.g. one pov holding elements 0 and 1 -> [{ povIndex: 1, elementIndex: 0, priority: 3n, value: 7n }, { povIndex: 1, elementIndex: 1, ... }]; seen != population throws
    async entries(): Promise<QpiCollectionEntry[]> {
        const population = populationOf(await readUint64(this.source, this.geometry.populationOffset), this.capacity);
        // Flags read before the empty shortcut: population counts elements, flags index PoVs.
        const flags = await readQpiBytes(this.source, this.geometry.flagsOffset, this.geometry.flagsBytes);
        const povIndices = occupiedSlotIndices(flags, this.capacity);
        if (!population) {
            if (povIndices.length) {
                throw new QpiContainerConsistencyError(`Collection has ${povIndices.length} active PoVs but population 0`);
            }
            return [];
        }
        if (!povIndices.length || povIndices.length > population) {
            throw new QpiContainerConsistencyError("Collection population does not match its active PoVs");
        }

        const povs = await this.readPovs(povIndices, population);
        if (povs.reduce((sum, pov) => sum + pov.population, 0) !== population) {
            throw new QpiContainerConsistencyError("Collection population does not match its PoV populations");
        }

        const elementBytes = await readQpiBytes(this.source, this.geometry.elementsOffset, population * this.geometry.elementStride);
        const elements = Array.from({ length: population }, (_, index) => this.elementAt(elementBytes, index));
        const activePovs = new Set(povIndices);
        for (let index = 0; index < elements.length; index++) {
            const povIndex = elements[index].povIndex;
            if (povIndex < 0n || povIndex >= BigInt(this.capacity) || !activePovs.has(Number(povIndex))) {
                throw new QpiContainerConsistencyError(`Collection element ${index} has invalid PoV ${povIndex}`);
            }
        }

        const entries: QpiCollectionEntry[] = [];
        const seen = new Set<number>();
        for (const pov of povs) {
            const orderedIndices = this.walkPov(pov, elements, seen, population);
            for (const elementIndex of orderedIndices) {
                const offset = elementIndex * this.geometry.elementStride;
                entries.push({
                    povIndex: pov.povIndex,
                    elementIndex,
                    pov: pov.value,
                    priority: elements[elementIndex].priority,
                    value: await decodeAbiValue(
                        elementBytes.slice(offset + this.geometry.elementValueOffset, offset + this.geometry.elementValueOffset + this.type.value.size),
                        this.type.value,
                    ),
                });
            }
        }

        if (seen.size !== population) {
            throw new QpiContainerConsistencyError(`Collection has ${seen.size} reachable elements, expected ${population}`);
        }
        return entries;
    }

    // e.g. pov slot 1 -> a 64-byte read at 64: id at +0, population +32, headIndex +40, tailIndex +48, bstRootIndex +56
    private async readPovs(povIndices: number[], totalPopulation: number): Promise<CollectionPov[]> {
        const povs: CollectionPov[] = [];
        for (const range of occupiedRanges(povIndices)) {
            const count = range.end - range.start + 1;
            const bytes = await readQpiBytes(this.source, this.geometry.povsOffset + range.start * this.geometry.povStride, count * this.geometry.povStride);
            for (let index = 0; index < count; index++) {
                const offset = index * this.geometry.povStride;
                const population = populationOf(uint64At(bytes, offset + this.geometry.povPopulationOffset), totalPopulation);
                if (!population) {
                    throw new QpiContainerConsistencyError(`Collection PoV ${range.start + index} is active but empty`);
                }
                povs.push({
                    povIndex: range.start + index,
                    value: await decodeAbiValue(
                        bytes.slice(offset + this.geometry.povValueOffset, offset + this.geometry.povValueOffset + POV_TYPE.size),
                        POV_TYPE,
                    ),
                    population,
                    headIndex: sint64At(bytes, offset + this.geometry.povHeadIndexOffset),
                    tailIndex: sint64At(bytes, offset + this.geometry.povTailIndexOffset),
                    bstRootIndex: sint64At(bytes, offset + this.geometry.povBstRootIndexOffset),
                });
            }
        }
        return povs;
    }

    // the trailer after the value: priority, povIndex, bstParent, bstLeft, bstRight, 8 bytes each
    private elementAt(bytes: Uint8Array, index: number): CollectionElement {
        const offset = index * this.geometry.elementStride;
        return {
            priority: sint64At(bytes, offset + this.geometry.elementPriorityOffset),
            povIndex: sint64At(bytes, offset + this.geometry.elementPovIndexOffset),
            bstParentIndex: sint64At(bytes, offset + this.geometry.elementBstParentIndexOffset),
            bstLeftIndex: sint64At(bytes, offset + this.geometry.elementBstLeftIndexOffset),
            bstRightIndex: sint64At(bytes, offset + this.geometry.elementBstRightIndexOffset),
        };
    }

    // in-order walk of the pov's bst with an explicit stack, e.g. root 1 with left 0 and right 2 -> [0, 1, 2]
    // head, tail, population and every parent link are checked on the way
    private walkPov(pov: CollectionPov, elements: CollectionElement[], seen: Set<number>, population: number): number[] {
        const root = elementIndex(pov.bstRootIndex, population, "root");
        const head = elementIndex(pov.headIndex, population, "head");
        const tail = elementIndex(pov.tailIndex, population, "tail");
        const ordered: number[] = [];
        const stack: Array<{
            index: number;
            parent: bigint;
            emit: boolean;
        }> = [{ index: root, parent: NULL_INDEX, emit: false }];

        while (stack.length) {
            const frame = stack.pop()!;
            if (frame.emit) {
                ordered.push(frame.index);
                continue;
            }
            if (seen.has(frame.index)) {
                throw new QpiContainerConsistencyError(`Collection element ${frame.index} is repeated or cyclic`);
            }
            const element = elements[frame.index];
            if (element.povIndex !== BigInt(pov.povIndex)) {
                throw new QpiContainerConsistencyError(`Collection element ${frame.index} belongs to PoV ${element.povIndex}, expected ${pov.povIndex}`);
            }
            if (element.bstParentIndex !== frame.parent) {
                throw new QpiContainerConsistencyError(`Collection element ${frame.index} has parent ${element.bstParentIndex}, expected ${frame.parent}`);
            }
            seen.add(frame.index);

            const right = optionalElementIndex(element.bstRightIndex, population, "right");
            if (right !== null) {
                stack.push({ index: right, parent: BigInt(frame.index), emit: false });
            }
            stack.push({ ...frame, emit: true });
            const left = optionalElementIndex(element.bstLeftIndex, population, "left");
            if (left !== null) {
                stack.push({ index: left, parent: BigInt(frame.index), emit: false });
            }
        }

        if (ordered.length !== pov.population) {
            throw new QpiContainerConsistencyError(`Collection PoV ${pov.povIndex} has ${ordered.length} elements, expected ${pov.population}`);
        }
        if (ordered[0] !== head || ordered[ordered.length - 1] !== tail) {
            throw new QpiContainerConsistencyError(`Collection PoV ${pov.povIndex} has an invalid head or tail`);
        }
        return ordered;
    }
}

function assertCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new Error("Collection capacity must be a positive power of two");
    }
    const integer = BigInt(capacity);
    if ((integer & (integer - 1n)) !== 0n) {
        throw new Error("Collection capacity must be a positive power of two");
    }
}

function assertSource(source: QpiByteSource, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("Collection ABI has an invalid size");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
        throw new QpiIncompleteReadError(`Collection needs ${size} bytes, source has ${source.byteLength}`);
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

function elementIndex(value: bigint, population: number, label: string): number {
    if (value < 0n || value >= BigInt(population)) {
        throw new QpiContainerConsistencyError(`Collection has invalid ${label} element index ${value}`);
    }
    return Number(value);
}

// -1n -> null (no child), else the index
function optionalElementIndex(value: bigint, population: number, label: string): number | null {
    return value === NULL_INDEX ? null : elementIndex(value, population, label);
}
