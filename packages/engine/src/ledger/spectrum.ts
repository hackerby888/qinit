// Entity balance ledger with an incremental depth-24 spectrum Merkle tree.
// Ports spectrum.h: increaseEnergy takes a key and creates, decreaseEnergy takes an index and guards.
import type { Entity } from "../contract/runtime";
import type { Id } from "../support/bytes";
import { toHex, k12Bytes } from "../support/k12";
import { SparseMerkle } from "./merkle";
import { M256i, EntityRecord, SPECTRUM_DEPTH } from "../protocol/wire";
import { hexToBytes } from "@qinit/core";

const SPECTRUM_CAPACITY = 1 << SPECTRUM_DEPTH;
const SPECTRUM_INDEX_MASK = SPECTRUM_CAPACITY - 1;
const ZERO_ID_KEY = "00".repeat(32);

// Stands in for core's `system.tick` global, which the energy calls read directly.
export interface SpectrumHost {
    tick(): number;
}

export class SpectrumLedger {
    private readonly host: SpectrumHost;
    private entities = new Map<string, Entity>(); // hex(id) -> Entity (balance = incoming - outgoing)
    private tree: SparseMerkle | null = null; // incremental 2^24 merkle; root = spectrumDigest
    private slotKeys = new Map<number, string>(); // occupied Core spectrum slots
    private dirtySlots = new Set<number>(); // leaves changed since the last digest

    constructor(host: SpectrumHost) {
        this.host = host;
    }

    get numberOfEntities(): number {
        return this.entities.size;
    }

    private key(id: Id): string {
        return toHex(id.subarray(0, 32));
    }

    private probe(publicKey: Id, key: string, claim: boolean): number {
        if (key === ZERO_ID_KEY) {
            return -1;
        }

        let index = ((publicKey[0] ?? 0) | ((publicKey[1] ?? 0) << 8) | ((publicKey[2] ?? 0) << 16) | ((publicKey[3] ?? 0) << 24)) & SPECTRUM_INDEX_MASK;
        const initialIndex = index;

        do {
            const occupiedKey = this.slotKeys.get(index);
            if (occupiedKey === key) {
                return index;
            }
            if (occupiedKey === undefined) {
                if (!claim) {
                    return -1;
                }
                this.slotKeys.set(index, key);
                return index;
            }
            index = (index + 1) & SPECTRUM_INDEX_MASK;
        } while (index !== initialIndex);

        if (claim) {
            throw new Error("spectrum is full");
        }
        return -1;
    }

    // Never creates; core claims a free slot inside increaseEnergy instead.
    spectrumIndex(publicKey: Id): number {
        return this.probe(publicKey, this.key(publicKey), false);
    }

    private emptyEntity(): Entity {
        return {
            incomingAmount: 0n,
            outgoingAmount: 0n,
            numberOfIncomingTransfers: 0,
            numberOfOutgoingTransfers: 0,
            latestIncomingTransferTick: 0,
            latestOutgoingTransferTick: 0,
        };
    }

    private entityAt(index: number): Entity | null {
        const key = this.slotKeys.get(index);
        return key === undefined ? null : (this.entities.get(key) ?? null);
    }

    getEntity(id: Id): Entity | null {
        return this.entities.get(this.key(id)) ?? null;
    }

    // The explorer's circulating supply — walks the whole map, which stays small at development scale.
    totalAmount(): bigint {
        let total = 0n;
        for (const e of this.entities.values()) {
            total += e.incomingAmount - e.outgoingAmount;
        }
        return total;
    }

    energy(index: number): bigint {
        const e = this.entityAt(index);
        return e ? e.incomingAmount - e.outgoingAmount : 0n;
    }

    increaseEnergy(publicKey: Id, amount: bigint): void {
        if (amount < 0n) {
            return;
        }

        const key = this.key(publicKey);
        const index = this.probe(publicKey, key, true);
        if (index < 0) {
            return;
        }

        let e = this.entities.get(key);
        if (!e) {
            e = this.emptyEntity();
            this.entities.set(key, e);
        }

        e.incomingAmount += amount;
        e.numberOfIncomingTransfers++;
        e.latestIncomingTransferTick = this.host.tick();
        this.dirtySlots.add(index);
    }

    decreaseEnergy(index: number, amount: bigint): boolean {
        if (amount < 0n) {
            return false;
        }

        const e = this.entityAt(index);
        if (!e || this.energy(index) < amount) {
            return false;
        }

        e.outgoingAmount += amount;
        e.numberOfOutgoingTransfers++;
        e.latestOutgoingTransferTick = this.host.tick();
        this.dirtySlots.add(index);

        return true;
    }

    // Core walks occupied hash slots, not identity byte order.
    nextId(id: Id): Id {
        const currentIndex = this.spectrumIndex(id);
        let nextIndex = SPECTRUM_CAPACITY;
        for (const index of this.slotKeys.keys()) {
            if (index > currentIndex && index < nextIndex) {
                nextIndex = index;
            }
        }

        const nextKey = this.slotKeys.get(nextIndex);
        return nextKey === undefined ? new Uint8Array(32) : hexToBytes(nextKey, 32);
    }

    prevId(id: Id): Id {
        const currentIndex = this.spectrumIndex(id);
        let previousIndex = -1;
        for (const index of this.slotKeys.keys()) {
            if (index < currentIndex && index > previousIndex) {
                previousIndex = index;
            }
        }

        const previousKey = this.slotKeys.get(previousIndex);
        return previousKey === undefined ? new Uint8Array(32) : hexToBytes(previousKey, 32);
    }

    // The 64-byte EntityRecord whose K12 is the spectrum leaf (the layout a client reads back from getEntity).
    private entityRecord(k: string): Uint8Array {
        const rec = EntityRecord.alloc();
        rec.publicKey = M256i.from(hexToBytes(k, 32));
        const e = this.entities.get(k);
        if (e) {
            rec.incomingAmount = e.incomingAmount;
            rec.outgoingAmount = e.outgoingAmount;
            rec.numberOfIncomingTransfers = e.numberOfIncomingTransfers;
            rec.numberOfOutgoingTransfers = e.numberOfOutgoingTransfers;
            rec.latestIncomingTransferTick = e.latestIncomingTransferTick;
            rec.latestOutgoingTransferTick = e.latestOutgoingTransferTick;
        }
        return rec.bytes;
    }

    // getSpectrumDigest — the root of the incremental 2^24 merkle. Only entities whose balance changed since the
    // last call are rehashed (24 nodes each); empty subtrees collapse to a precomputed hash. leaf = K12(EntityRecord).
    getSpectrumDigest(): Uint8Array {
        if (!this.tree) {
            this.tree = new SparseMerkle(k12Bytes(new Uint8Array(64)), SPECTRUM_DEPTH);
        }

        for (const index of this.dirtySlots) {
            const key = this.slotKeys.get(index);
            if (key !== undefined) {
                this.tree.setLeaf(index, k12Bytes(this.entityRecord(key)));
            }
        }
        this.dirtySlots.clear();
        return this.tree.root();
    }

    // The merkle proof for an entity: its leaf index + the 24 sibling hashes from the leaf to the spectrum root. A
    // client recomputes the root from (EntityRecord, index, siblings) and checks it against spectrumDigest.
    spectrumProof(id: Id): { record: Uint8Array; index: number; siblings: Uint8Array[] } {
        this.getSpectrumDigest(); // flush pending leaf updates so the tree reflects the current state
        const k = this.key(id);
        const record = this.entityRecord(k);
        const index = this.spectrumIndex(id);
        if (index < 0 || !this.tree) {
            return { record, index: -1, siblings: [] };
        }

        return { record, index, siblings: this.tree.siblings(index) };
    }
}
