// The spectrum — every entity's balance record (energy = incomingAmount - outgoingAmount) and the incremental
// 2^24 merkle whose root is the spectrumDigest. The TS mirror of core-lite spectrum/spectrum.h (energy /
// increaseEnergy / decreaseEnergy / getSpectrumDigest). Pure ledger: no contract / fee / asset coupling — the
// orchestrator (Sim) layers transfer/burn policy on top of these primitives.
import type { Entity } from "./runtime";
import { toHex, k12Bytes } from "./k12";
import { SparseMerkle } from "./merkle";
import { M256i, EntityRecord } from "./wire";

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export class SpectrumLedger {
  private entities = new Map<string, Entity>(); // hex(id) -> Entity (balance = incoming - outgoing)
  private tree: SparseMerkle | null = null; // incremental 2^24 merkle; root = spectrumDigest
  private idx = new Map<string, number>(); // entity id -> stable leaf index
  private dirty = new Set<string>(); // entity ids whose leaf changed since the last digest

  get size(): number {
    return this.entities.size;
  }

  private key(id: Uint8Array): string {
    return toHex(id.subarray(0, 32));
  }

  private emptyEntity(): Entity {
    return { incomingAmount: 0n, outgoingAmount: 0n, numberOfIncomingTransfers: 0, numberOfOutgoingTransfers: 0, latestIncomingTransferTick: 0, latestOutgoingTransferTick: 0 };
  }

  entityOf(id: Uint8Array): Entity | null {
    return this.entities.get(this.key(id)) ?? null;
  }

  // energy(index) — the spendable balance.
  energy(id: Uint8Array): bigint {
    const e = this.entities.get(this.key(id));
    return e ? e.incomingAmount - e.outgoingAmount : 0n;
  }

  // increaseEnergy — credit an entity's incoming side (creating the record if new).
  increaseEnergy(id: Uint8Array, amount: bigint, tick: number): void {
    const k = this.key(id);
    let e = this.entities.get(k);
    if (!e) {
      e = this.emptyEntity();
      this.entities.set(k, e);
    }

    e.incomingAmount += amount;
    e.numberOfIncomingTransfers++;
    e.latestIncomingTransferTick = tick;
    this.dirty.add(k);
  }

  // decreaseEnergy — debit an entity's outgoing side.
  decreaseEnergy(id: Uint8Array, amount: bigint, tick: number): void {
    const k = this.key(id);
    let e = this.entities.get(k);
    if (!e) {
      e = this.emptyEntity();
      this.entities.set(k, e);
    }

    e.outgoingAmount += amount;
    e.numberOfOutgoingTransfers++;
    e.latestOutgoingTransferTick = tick;
    this.dirty.add(k);
  }

  // Spectrum iteration (qpi.nextId/prevId) — the next/previous occupied entity id; zero if none. The node walks
  // the spectrum hash array; the dev engine uses a deterministic id order over the occupied entities.
  nextId(id: Uint8Array): Uint8Array {
    const target = this.key(id);
    let best: string | null = null;
    for (const k of this.entities.keys()) {
      if (k > target && (best === null || k < best)) best = k;
    }

    return best === null ? new Uint8Array(32) : hexToBytes32(best);
  }

  prevId(id: Uint8Array): Uint8Array {
    const target = this.key(id);
    let best: string | null = null;
    for (const k of this.entities.keys()) {
      if (k < target && (best === null || k > best)) best = k;
    }

    return best === null ? new Uint8Array(32) : hexToBytes32(best);
  }

  // The 64-byte EntityRecord whose K12 is the spectrum leaf (the layout a client reads back from getEntity).
  private entityRecord(k: string): Uint8Array {
    const rec = EntityRecord.alloc();
    rec.publicKey = M256i.from(hexToBytes32(k));
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

  // Assign (and remember) a stable leaf index for an entity key.
  private leafIndex(key: string): number {
    const existing = this.idx.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const next = this.idx.size;
    this.idx.set(key, next);
    return next;
  }

  // getSpectrumDigest — the root of the incremental 2^24 merkle. Only entities whose balance changed since the
  // last call are rehashed (24 nodes each); empty subtrees collapse to a precomputed hash. leaf = K12(EntityRecord).
  getSpectrumDigest(): Uint8Array {
    if (!this.tree) {
      this.tree = new SparseMerkle(k12Bytes(new Uint8Array(64)));
    }

    for (const k of this.dirty) {
      this.tree.setLeaf(this.leafIndex(k), k12Bytes(this.entityRecord(k)));
    }
    this.dirty.clear();
    return this.tree.root();
  }

  // The merkle proof for an entity: its leaf index + the 24 sibling hashes from the leaf to the spectrum root. A
  // client recomputes the root from (EntityRecord, index, siblings) and checks it against spectrumDigest.
  spectrumProof(id: Uint8Array): { record: Uint8Array; index: number; siblings: Uint8Array[] } {
    this.getSpectrumDigest(); // flush pending leaf updates so the tree reflects the current state
    const k = this.key(id);
    const record = this.entityRecord(k);
    const index = this.idx.get(k);
    if (index === undefined || !this.tree) {
      return { record, index: -1, siblings: [] };
    }

    return { record, index, siblings: this.tree.siblings(index) };
  }
}
