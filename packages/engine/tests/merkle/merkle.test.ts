// Sparse merkle — the incremental 2^24 tree backing spectrum/universe. Asserts the empty-tree root, that a
// leaf's siblings reproduce the root (the proof a client verifies via getDigestFromSiblings), and that
// incremental updates match a from-scratch rebuild.
import { test, expect } from "bun:test";
import { initK12, k12Bytes, toHex } from "../../src/k12";
import { SparseMerkle, MERKLE_DEPTH, rootFromSiblings } from "../../src/merkle";

const EMPTY = new Uint8Array(32);

test("MERKLE_DEPTH is 24 (SPECTRUM_DEPTH / ASSETS_DEPTH)", () => {
  expect(MERKLE_DEPTH).toBe(24);
});

test("setting a leaf changes the root + yields a 24-sibling proof", async () => {
  await initK12();
  const t = new SparseMerkle(k12Bytes(EMPTY));
  const empty = toHex(t.root());

  t.setLeaf(5, k12Bytes(new Uint8Array([1, 2, 3])));
  expect(toHex(t.root())).not.toBe(empty);
  expect(t.siblings(5).length).toBe(24);
});

test("a leaf's siblings reproduce the root (the proof a client verifies)", async () => {
  await initK12();
  const t = new SparseMerkle(k12Bytes(EMPTY));
  const records = new Map<number, Uint8Array>([
    [0, new Uint8Array([9, 9])],
    [3, new Uint8Array([7])],
    [1000000, new Uint8Array([1, 2, 3, 4])], // a far-apart index, exercising sparse subtrees
  ]);
  for (const [i, r] of records) {
    t.setLeaf(i, k12Bytes(r));
  }

  for (const [i, r] of records) {
    expect(toHex(rootFromSiblings(r, i, t.siblings(i)))).toBe(toHex(t.root()));
  }
});

test("incremental updates equal a from-scratch rebuild (the dirty-path is correct)", async () => {
  await initK12();

  const a = new SparseMerkle(k12Bytes(EMPTY));
  a.setLeaf(2, k12Bytes(new Uint8Array([1])));
  a.setLeaf(7, k12Bytes(new Uint8Array([2])));
  a.setLeaf(2, k12Bytes(new Uint8Array([3]))); // overwrite index 2

  const b = new SparseMerkle(k12Bytes(EMPTY)); // only the final value per index
  b.setLeaf(7, k12Bytes(new Uint8Array([2])));
  b.setLeaf(2, k12Bytes(new Uint8Array([3])));

  expect(toHex(a.root())).toBe(toHex(b.root()));
});
