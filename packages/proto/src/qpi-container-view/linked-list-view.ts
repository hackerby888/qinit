import { decodeAbiValue } from "../abi/decode";
import { AbiTypeKind, type AbiLinkedList } from "../contract-idl";
import { linkedListGeometry } from "../qpi-layout";
import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
import { occupiedRanges, readQpiBytes, readUint64, sint64At, type QpiByteSource } from "./source";

const NULL_INDEX = -1n;

// e.g. { elementIndex: 2, value: 7n }, in list order (head to tail), not slot order
export interface QpiLinkedListEntry {
    elementIndex: number;
    value: unknown;
}

// core: struct Node { T value; sint64 nextIndex; sint64 prevIndex; }
interface LinkedListNode extends QpiLinkedListEntry {
    nextIndex: bigint;
    prevIndex: bigint;
}

// reads _population, the 1-bit _occupiedFlags, head and tail, then walks the nodes head to tail
export class QpiLinkedListView {
    readonly kind = AbiTypeKind.LINKED_LIST;
    readonly capacity: number;

    private readonly geometry;

    constructor(
        readonly type: AbiLinkedList,
        private readonly source: QpiByteSource,
    ) {
        this.capacity = type.capacity;
        assertCapacity(type.capacity);
        this.geometry = linkedListGeometry(type.value, type.capacity);
        if (type.align !== this.geometry.align || this.geometry.size !== type.size) {
            throw new Error("LinkedList ABI layout has an invalid size or alignment");
        }
        assertSource(source, type.size);
    }

    // e.g. slots 0 and 2 occupied, head 2, tail 0 -> [{ elementIndex: 2, value: 9n }, { elementIndex: 0, value: 7n }]
    // a walk that ends early, misses the tail or revisits a slot throws
    async entries(): Promise<QpiLinkedListEntry[]> {
        const population = populationOf(await readUint64(this.source, this.geometry.populationOffset), this.capacity);
        // Flags read before the empty shortcut: population 0 over occupied slots is an inconsistency, not empty.
        const flags = await readQpiBytes(this.source, this.geometry.flagsOffset, this.geometry.flagsBytes);
        const occupiedIndices: number[] = [];
        for (let elementIndex = 0; elementIndex < this.capacity; elementIndex++) {
            if (occupiedAt(flags, elementIndex)) {
                occupiedIndices.push(elementIndex);
            }
        }
        if (occupiedIndices.length !== population) {
            throw new QpiContainerConsistencyError(`LinkedList has ${occupiedIndices.length} occupied slots but population ${population}`);
        }
        if (!population) {
            return [];
        }

        const header = await readQpiBytes(this.source, this.geometry.headIndexOffset, 16);
        const head = sint64At(header, 0);
        const tail = sint64At(header, 8);
        const occupied = new Set(occupiedIndices);
        if (!isSlot(head, this.capacity) || !isSlot(tail, this.capacity) || !occupied.has(Number(head)) || !occupied.has(Number(tail))) {
            throw new QpiContainerConsistencyError(`LinkedList has invalid head ${head} or tail ${tail}`);
        }

        const nodes = await this.readNodes(occupiedIndices);
        for (const node of nodes.values()) {
            this.assertLink(node.nextIndex, occupied, node.elementIndex, "next");
            this.assertLink(node.prevIndex, occupied, node.elementIndex, "previous");
        }

        // head to tail, with the occupied set as the cycle guard: a corrupt nextIndex would otherwise loop forever
        const ordered: QpiLinkedListEntry[] = [];
        const seen = new Set<number>();
        let current = head;
        let previous = NULL_INDEX;
        for (let position = 0; position < population; position++) {
            if (!isSlot(current, this.capacity)) {
                throw new QpiContainerConsistencyError(`LinkedList has invalid next index ${current}`);
            }
            const elementIndex = Number(current);
            const node = nodes.get(elementIndex);
            if (!node || seen.has(elementIndex)) {
                throw new QpiContainerConsistencyError(`LinkedList contains an unoccupied, repeated, or cyclic slot ${elementIndex}`);
            }
            if (node.prevIndex !== previous) {
                throw new QpiContainerConsistencyError(`LinkedList slot ${elementIndex} has previous ${node.prevIndex}, expected ${previous}`);
            }
            seen.add(elementIndex);
            ordered.push({ elementIndex, value: node.value });
            previous = current;
            current = node.nextIndex;
        }

        if (current !== NULL_INDEX || previous !== tail || seen.size !== occupied.size) {
            throw new QpiContainerConsistencyError("LinkedList topology does not match its population and tail");
        }
        return ordered;
    }

    // the occupied nodes by slot, links at value + 8 and + 16, e.g. { 0 => { value: 7n, nextIndex: 1n, prevIndex: -1n } }
    private async readNodes(occupiedIndices: number[]): Promise<Map<number, LinkedListNode>> {
        const nodes = new Map<number, LinkedListNode>();
        for (const range of occupiedRanges(occupiedIndices)) {
            const count = range.end - range.start + 1;
            const bytes = await readQpiBytes(this.source, range.start * this.geometry.nodeStride, count * this.geometry.nodeStride);
            for (let index = 0; index < count; index++) {
                const elementIndex = range.start + index;
                const offset = index * this.geometry.nodeStride;
                nodes.set(elementIndex, {
                    elementIndex,
                    value: await decodeAbiValue(bytes.slice(offset, offset + this.type.value.size), this.type.value),
                    nextIndex: sint64At(bytes, offset + this.geometry.nextIndexOffset),
                    prevIndex: sint64At(bytes, offset + this.geometry.prevIndexOffset),
                });
            }
        }
        return nodes;
    }

    private assertLink(value: bigint, occupied: Set<number>, elementIndex: number, label: string): void {
        if (value !== NULL_INDEX && (!isSlot(value, this.capacity) || !occupied.has(Number(value)))) {
            throw new QpiContainerConsistencyError(`LinkedList slot ${elementIndex} has invalid ${label} index ${value}`);
        }
    }
}

function assertCapacity(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new Error("LinkedList capacity must be a positive power of two");
    }
    const integer = BigInt(capacity);
    if ((integer & (integer - 1n)) !== 0n) {
        throw new Error("LinkedList capacity must be a positive power of two");
    }
}

function assertSource(source: QpiByteSource, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("LinkedList ABI has an invalid size");
    }
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
        throw new QpiIncompleteReadError(`LinkedList needs ${size} bytes, source has ${source.byteLength}`);
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

// core's 1-bit _occupiedFlags: 1 occupied, 0 free
function occupiedAt(occupiedFlags: Uint8Array, elementIndex: number): boolean {
    return ((occupiedFlags[elementIndex >> 3] >> (elementIndex & 7)) & 1) !== 0;
}

function isSlot(value: bigint, capacity: number): boolean {
    return value >= 0n && value < BigInt(capacity);
}
