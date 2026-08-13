import { decodeAbiValue } from "../abi-fmt";
import { AbiTypeKind, type AbiLinkedList } from "../contract-idl";
import { linkedListGeometry } from "../qpi-layout";
import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";
import { readQpiBytes, readUint64, sint64At, type QpiByteSource } from "./source";

const NULL_INDEX = -1n;

export interface QpiLinkedListEntry {
    slot: number;
    value: unknown;
}

interface LinkedListNode extends QpiLinkedListEntry {
    next: bigint;
    previous: bigint;
}

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

    async entries(): Promise<QpiLinkedListEntry[]> {
        const population = populationOf(
            await readUint64(this.source, this.geometry.populationOffset),
            this.capacity,
        );
        if (!population) {
            return [];
        }

        const flags = await readQpiBytes(
            this.source,
            this.geometry.flagsOffset,
            this.geometry.flagsBytes,
        );
        const occupiedSlots: number[] = [];
        for (let slot = 0; slot < this.capacity; slot++) {
            if (occupiedAt(flags, slot)) {
                occupiedSlots.push(slot);
            }
        }
        if (occupiedSlots.length !== population) {
            throw new QpiContainerConsistencyError(
                `LinkedList has ${occupiedSlots.length} occupied slots but population ${population}`,
            );
        }

        const header = await readQpiBytes(this.source, this.geometry.headOffset, 16);
        const head = sint64At(header, 0);
        const tail = sint64At(header, 8);
        const occupied = new Set(occupiedSlots);
        if (
            !isSlot(head, this.capacity) ||
            !isSlot(tail, this.capacity) ||
            !occupied.has(Number(head)) ||
            !occupied.has(Number(tail))
        ) {
            throw new QpiContainerConsistencyError(
                `LinkedList has invalid head ${head} or tail ${tail}`,
            );
        }

        const nodes = await this.readNodes(occupiedSlots);
        for (const node of nodes.values()) {
            this.assertLink(node.next, occupied, node.slot, "next");
            this.assertLink(node.previous, occupied, node.slot, "previous");
        }

        const ordered: QpiLinkedListEntry[] = [];
        const seen = new Set<number>();
        let current = head;
        let previous = NULL_INDEX;
        for (let position = 0; position < population; position++) {
            if (!isSlot(current, this.capacity)) {
                throw new QpiContainerConsistencyError(
                    `LinkedList has invalid next index ${current}`,
                );
            }
            const slot = Number(current);
            const node = nodes.get(slot);
            if (!node || seen.has(slot)) {
                throw new QpiContainerConsistencyError(
                    `LinkedList contains an unoccupied, repeated, or cyclic slot ${slot}`,
                );
            }
            if (node.previous !== previous) {
                throw new QpiContainerConsistencyError(
                    `LinkedList slot ${slot} has previous ${node.previous}, expected ${previous}`,
                );
            }
            seen.add(slot);
            ordered.push({ slot, value: node.value });
            previous = current;
            current = node.next;
        }

        if (current !== NULL_INDEX || previous !== tail || seen.size !== occupied.size) {
            throw new QpiContainerConsistencyError(
                "LinkedList topology does not match its population and tail",
            );
        }
        return ordered;
    }

    private async readNodes(slots: number[]): Promise<Map<number, LinkedListNode>> {
        const nodes = new Map<number, LinkedListNode>();
        for (const range of occupiedRanges(slots)) {
            const count = range.end - range.start + 1;
            const bytes = await readQpiBytes(
                this.source,
                range.start * this.geometry.nodeStride,
                count * this.geometry.nodeStride,
            );
            for (let index = 0; index < count; index++) {
                const slot = range.start + index;
                const offset = index * this.geometry.nodeStride;
                nodes.set(slot, {
                    slot,
                    value: await decodeAbiValue(
                        bytes.slice(offset, offset + this.type.value.size),
                        this.type.value,
                    ),
                    next: sint64At(bytes, offset + this.geometry.nextOffset),
                    previous: sint64At(bytes, offset + this.geometry.prevOffset),
                });
            }
        }
        return nodes;
    }

    private assertLink(value: bigint, occupied: Set<number>, slot: number, label: string): void {
        if (
            value !== NULL_INDEX &&
            (!isSlot(value, this.capacity) || !occupied.has(Number(value)))
        ) {
            throw new QpiContainerConsistencyError(
                `LinkedList slot ${slot} has invalid ${label} index ${value}`,
            );
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
        throw new QpiIncompleteReadError(
            `LinkedList needs ${size} bytes, source has ${source.byteLength}`,
        );
    }
    if (!Number.isSafeInteger(source.maxReadLength) || source.maxReadLength <= 0) {
        throw new Error("QPI byte source has an invalid maxReadLength");
    }
}

function populationOf(population: bigint, capacity: number): number {
    if (population > BigInt(capacity)) {
        throw new QpiContainerConsistencyError(
            `container population ${population} exceeds capacity ${capacity}`,
        );
    }
    return Number(population);
}

function occupiedAt(flags: Uint8Array, slot: number): boolean {
    return ((flags[slot >> 3] >> (slot & 7)) & 1) !== 0;
}

function occupiedRanges(slots: number[]): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    for (const slot of slots) {
        const last = ranges[ranges.length - 1];
        if (last && slot === last.end + 1) {
            last.end = slot;
        } else {
            ranges.push({ start: slot, end: slot });
        }
    }
    return ranges;
}

function isSlot(value: bigint, capacity: number): boolean {
    return value >= 0n && value < BigInt(capacity);
}
