// Sparse binary Merkle tree (depth 24 = SPECTRUM_DEPTH / ASSETS_DEPTH) with incremental updates. The full tree
// has 2^24 leaves; almost all are empty, so only the occupied paths are stored and each empty subtree collapses
// to a precomputed per-level hash. A leaf change rehashes just its 24-node path to the root — no full recompute.
// leaf = K12(record); parent = K12(leftChild ‖ rightChild) where the left child is the even-index sibling. This
// is exactly the hashing an external Qubic client's getDigestFromSiblings reproduces, so the proofs verify.
import { k12Bytes } from "./k12";

export const MERKLE_DEPTH = 24;
const DIGEST_SIZE = 32;

export class SparseMerkle {
  private nodes = new Map<string, Uint8Array>(); // "level:index" -> hash (occupied nodes only)
  private readonly empty: Uint8Array[]; // empty[level] — the hash of a fully-empty subtree rooted at `level`

  // `emptyLeaf` is the level-0 hash of an unoccupied slot (any fixed value; it only has to be used consistently).
  constructor(emptyLeaf: Uint8Array) {
    this.empty = [emptyLeaf.slice(0, DIGEST_SIZE)];
    for (let level = 1; level <= MERKLE_DEPTH; level++) {
      this.empty.push(hashPair(this.empty[level - 1], this.empty[level - 1]));
    }
  }

  private nodeAt(level: number, index: number): Uint8Array {
    return this.nodes.get(level + ":" + index) ?? this.empty[level];
  }

  // Set the leaf at `index` to `leafHash` and rehash its path to the root (24 K12 hashes).
  setLeaf(index: number, leafHash: Uint8Array): void {
    this.nodes.set("0:" + index, leafHash.slice(0, DIGEST_SIZE));

    let idx = index;
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      const left = this.nodeAt(level, idx & ~1);
      const right = this.nodeAt(level, idx | 1);
      idx = Math.floor(idx / 2);
      this.nodes.set((level + 1) + ":" + idx, hashPair(left, right));
    }
  }

  root(): Uint8Array {
    return this.nodeAt(MERKLE_DEPTH, 0);
  }

  // The 24 sibling hashes from the leaf up to the root — the proof for `index`.
  siblings(index: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    let idx = index;
    for (let level = 0; level < MERKLE_DEPTH; level++) {
      out.push(this.nodeAt(level, idx ^ 1));
      idx = Math.floor(idx / 2);
    }
    return out;
  }
}

// Concatenate two 32-byte hashes and K12 them — one tree node.
function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  const pair = new Uint8Array(2 * DIGEST_SIZE);
  pair.set(left.subarray(0, DIGEST_SIZE), 0);
  pair.set(right.subarray(0, DIGEST_SIZE), DIGEST_SIZE);
  return k12Bytes(pair);
}

// Recompute the root from a leaf record + its index + siblings — mirrors getDigestFromSiblings. For verifying
// that a proof reproduces the tree's root (the check an external client performs).
export function rootFromSiblings(record: Uint8Array, index: number, siblings: Uint8Array[]): Uint8Array {
  let digest = k12Bytes(record);
  let idx = index;
  for (const sib of siblings) {
    digest = idx % 2 === 1 ? hashPair(sib, digest) : hashPair(digest, sib);
    idx = Math.floor(idx / 2);
  }
  return digest;
}
