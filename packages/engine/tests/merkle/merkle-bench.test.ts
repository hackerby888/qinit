// Confirms spectrum and universe updates rehash only affected depth-24 Merkle paths.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex, k12Bytes } from "../../src/k12";
import { SparseMerkle, MERKLE_DEPTH } from "../../src/merkle";
import { SpectrumLedger } from "../../src/spectrum";
import { AssetLedger } from "../../src/assets";
import { contractId } from "../support/helpers";

const LEAF_SPACE = 1 << MERKLE_DEPTH; // 2^24 — the full leaf index range

beforeAll(async () => {
  await initK12(); // every leaf / node hashes through K12
});

// A small deterministic PRNG (mulberry32) so the seeded op sequences are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entityId(n: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setUint32(0, n, true);
  a[31] = n & 0xff;
  return a;
}

test("SparseMerkle: the root is order-independent and overwrites collapse to the last value", () => {
  const empty = k12Bytes(new Uint8Array(64));
  const r = rng(0xa11ce);
  const leaves = new Map<number, Uint8Array>();
  for (let i = 0; i < 64; i++) {
    leaves.set(
      Math.floor(r() * LEAF_SPACE),
      k12Bytes(Uint8Array.of(i, (i * 31) & 0xff, (i * 7) & 0xff)),
    );
  }

  const forward = new SparseMerkle(empty);
  for (const [idx, leaf] of leaves) {
    forward.setLeaf(idx, leaf);
  }

  const reverse = new SparseMerkle(empty);
  for (const [idx, leaf] of [...leaves].reverse()) {
    reverse.setLeaf(idx, leaf);
  }

  expect(toHex(forward.root())).toBe(toHex(reverse.root()));

  // Setting a leaf to junk and then to its real value must leave the same root as setting it once.
  const overwritten = new SparseMerkle(empty);
  for (const [idx, leaf] of leaves) {
    overwritten.setLeaf(idx, k12Bytes(Uint8Array.of(0xde, 0xad)));
    overwritten.setLeaf(idx, leaf);
  }
  expect(toHex(overwritten.root())).toBe(toHex(forward.root()));
});

test("SpectrumLedger: a digest taken after every op equals the one-shot batch digest", () => {
  const r = rng(0x5bec7a); // deterministic op stream
  const ops: { id: Uint8Array; credit: boolean; amount: bigint; tick: number }[] = [];
  for (let i = 0; i < 256; i++) {
    ops.push({
      id: entityId(Math.floor(r() * 50)), // reuse ids so records accumulate multiple transfers
      credit: r() < 0.5,
      amount: BigInt(1 + Math.floor(r() * 1000)),
      tick: 1 + Math.floor(r() * 100),
    });
  }

  const incremental = new SpectrumLedger();
  for (const op of ops) {
    if (op.credit) {
      incremental.increaseEnergy(op.id, op.amount, op.tick);
    } else {
      incremental.decreaseEnergy(op.id, op.amount, op.tick);
    }
    incremental.getSpectrumDigest(); // flush this op's dirty leaf through the incremental path
  }

  const batch = new SpectrumLedger();
  for (const op of ops) {
    if (op.credit) {
      batch.increaseEnergy(op.id, op.amount, op.tick);
    } else {
      batch.decreaseEnergy(op.id, op.amount, op.tick);
    }
  }

  expect(toHex(incremental.getSpectrumDigest())).toBe(toHex(batch.getSpectrumDigest()));
});

test("SpectrumLedger: re-reading the digest with no new changes returns the same root", () => {
  const led = new SpectrumLedger();
  led.increaseEnergy(entityId(1), 100n, 1);
  led.increaseEnergy(entityId(2), 200n, 1);

  const first = led.getSpectrumDigest();
  expect(toHex(led.getSpectrumDigest())).toBe(toHex(first)); // dirty cleared — idempotent

  const before = toHex(first);
  led.increaseEnergy(entityId(3), 1n, 2);
  expect(toHex(led.getSpectrumDigest())).not.toBe(before); // one new leaf moves the root
});

test("SpectrumLedger: one leaf update on a large spectrum is bounded work, not a full rebuild", () => {
  const led = new SpectrumLedger();
  for (let i = 0; i < 4000; i++) {
    led.increaseEnergy(entityId(i), 1000n, 1);
  }
  led.getSpectrumDigest(); // warm the tree

  const t0 = performance.now();
  led.increaseEnergy(entityId(999999), 1n, 2);
  led.getSpectrumDigest();
  const dt = performance.now() - t0;

  // A single 24-hash path costs well under a millisecond; an O(2^24) rebuild would take seconds. The loose bound
  // is a catastrophic-regression guard, not a micro-benchmark.
  expect(dt).toBeLessThan(100);
});

test("AssetLedger: a universe digest taken after every issuance equals the one-shot batch digest", () => {
  const issues: { slot: number; name: bigint }[] = [];
  for (let i = 0; i < 20; i++) {
    issues.push({ slot: i + 1, name: BigInt(65 + i) }); // single-letter names A..T (first byte A-Z)
  }

  const incremental = new AssetLedger({ contractId });
  for (const it of issues) {
    incremental.issueAsset(
      it.slot,
      it.name,
      contractId(it.slot),
      2,
      1000n,
      0n,
      contractId(it.slot),
    );
    incremental.getUniverseDigest();
  }

  const batch = new AssetLedger({ contractId });
  for (const it of issues) {
    batch.issueAsset(it.slot, it.name, contractId(it.slot), 2, 1000n, 0n, contractId(it.slot));
  }

  expect(toHex(incremental.getUniverseDigest())).toBe(toHex(batch.getUniverseDigest()));
});
