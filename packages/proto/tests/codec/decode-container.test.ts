import { test, expect } from "bun:test";
import {
  decodeCollection,
  decodeHashMap,
  decodeHashSet,
  decodeLinkedList,
} from "../../src/decode-container";
import { linkedListGeometry } from "../../src/qpi-layout";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiScalar,
  type AbiStruct,
} from "../../src/contract-idl";

// little-endian uint64 bytes
const le = (n: bigint): number[] => {
  const b: number[] = [];
  for (let i = 0; i < 8; i++) b.push(Number((n >> BigInt(8 * i)) & 0xffn));
  return b;
};
// little-endian signed int64 (handles -1 = NULL_INDEX)
const i64 = (n: number | bigint): number[] => {
  let v = BigInt.asUintN(64, BigInt(n));
  const b: number[] = [];
  for (let i = 0; i < 8; i++) {
    b.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return b;
};
// flag word for occupied slots `occ` and marked-removed slots `rem` (2 bits/slot, within one uint64 = 32 slots)
const flags = (occ: number[], rem: number[] = []): bigint => {
  let w = 0n;
  for (const i of occ) w |= 1n << BigInt((i & 31) * 2); // 01
  for (const i of rem) w |= 2n << BigInt((i & 31) * 2); // 10
  return w;
};

test("HashMap<uint64,uint64,4>: only occupied slots, in slot order", async () => {
  const buf = new Uint8Array(80); // 4*16 elems + 8 flags + counters
  buf.set(le(100n), 0);
  buf.set(le(5n), 8); // slot0: 100 -> 5
  buf.set(le(200n), 32);
  buf.set(le(7n), 40); // slot2: 200 -> 7
  buf.set(le(flags([0, 2])), 64);
  expect(await decodeHashMap(buf, "uint64", "uint64", 4)).toEqual([
    { slot: 0, key: 100n, value: 5n },
    { slot: 2, key: 200n, value: 7n },
  ]);
});

test("HashMap excludes empty (00) and marked-for-removal (10) slots", async () => {
  const buf = new Uint8Array(80);
  buf.set(le(9n), 0);
  buf.set(le(1n), 8); // slot0 occupied
  buf.set(le(8n), 16);
  buf.set(le(2n), 24); // slot1 marked-removed -> excluded
  buf.set(le(flags([0], [1])), 64); // slot0=01, slot1=10, slot2/3=00
  expect(await decodeHashMap(buf, "uint64", "uint64", 4)).toEqual([
    { slot: 0, key: 9n, value: 1n },
  ]);
});

test("HashMap<id,uint64,4>: id key decodes to a 60-char identity, value alongside", async () => {
  const buf = new Uint8Array(176); // element {id(32), uint64} stride 40; flags @160
  buf.set(le(42n), 32); // slot0 value=42 (key = all-zero id)
  buf.set(le(flags([0])), 160);
  const e = await decodeHashMap(buf, "id", "uint64", 4);
  expect(e.length).toBe(1);
  expect(e[0].slot).toBe(0);
  expect(e[0].value).toBe(42n);
  expect(typeof e[0].key).toBe("string");
  expect((e[0].key as string).length).toBe(60);
});

test("HashSet<uint64,4>: occupied keys", async () => {
  const buf = new Uint8Array(48); // 4*8 keys + 8 flags
  buf.set(le(11n), 0);
  buf.set(le(33n), 16); // slot0, slot2
  buf.set(le(flags([0, 2])), 32);
  expect(await decodeHashSet(buf, "uint64", 4)).toEqual([
    { slot: 0, key: 11n },
    { slot: 2, key: 33n },
  ]);
});

test("HashMap and HashSet align flags after byte-sized records", async () => {
  const map = new Uint8Array(32);
  map[0] = 7;
  map[1] = 9;
  map.set(le(flags([0])), 8);
  expect(await decodeHashMap(map, "uint8", "uint8", 1)).toEqual([
    { slot: 0, key: 7, value: 9 },
  ]);

  const set = new Uint8Array(32);
  set[0] = 11;
  set.set(le(flags([0])), 8);
  expect(await decodeHashSet(set, "uint8", 4)).toEqual([
    { slot: 0, key: 11 },
  ]);
});

test("empty container -> no entries", async () => {
  expect(await decodeHashMap(new Uint8Array(80), "uint64", "uint64", 4)).toEqual([]);
  expect(await decodeHashSet(new Uint8Array(48), "uint64", 4)).toEqual([]);
});

test("Collection<uint64,4>: per-PoV in-order BST walk = priority order", async () => {
  const cap = 4,
    povStride = 64,
    flagsOff = cap * povStride,
    elemsOff = flagsOff + 8,
    es = 48;
  const buf = new Uint8Array(elemsOff + cap * es + 16);
  buf.set(i64(0), 56); // PoV0.bstRootIndex = 0 (id = all-zero)
  buf.set(le(1n), flagsOff); // PoV0 occupied (flag 01)
  const E = (
    off: number,
    value: number,
    prio: number,
    parent: number,
    left: number,
    right: number,
  ) => {
    buf.set(i64(value), off);
    buf.set(i64(prio), off + 8);
    buf.set(i64(0), off + 16); // value, priority, povIndex
    buf.set(i64(parent), off + 24);
    buf.set(i64(left), off + 32);
    buf.set(i64(right), off + 40);
  };
  E(elemsOff + 0, 100, 5, -1, 1, 2); // root
  E(elemsOff + 48, 50, 2, 0, -1, -1); // left child  (priority 2)
  E(elemsOff + 96, 150, 9, 0, -1, -1); // right child (priority 9)
  const e = await decodeCollection(buf, "uint64", 4);
  expect(e.map((x) => [x.value, x.priority])).toEqual([
    [50n, 2n],
    [100n, 5n],
    [150n, 9n],
  ]); // in-order
  expect(typeof e[0].pov).toBe("string");
  expect((e[0].pov as string).length).toBe(60);
});

test("Collection: empty + single-element root", async () => {
  const cap = 4,
    elemsOff = cap * 64 + 8;
  expect(await decodeCollection(new Uint8Array(elemsOff + cap * 48 + 16), "uint64", 4)).toEqual([]);
  const buf = new Uint8Array(elemsOff + cap * 48 + 16);
  buf.set(i64(0), 56);
  buf.set(le(1n), cap * 64); // PoV0 occupied, root=0
  buf.set(i64(7), elemsOff);
  buf.set(i64(3), elemsOff + 8); // elem0 value=7 prio=3
  buf.set(i64(-1), elemsOff + 32);
  buf.set(i64(-1), elemsOff + 40); // no children
  const e = await decodeCollection(buf, "uint64", 4);
  expect(e.map((x) => [x.value, x.priority])).toEqual([[7n, 3n]]);
});

test("Collection aligns its element region to the value alignment", async () => {
  const uint64Type: AbiScalar = {
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.UINT64,
    size: 8,
    align: 8,
    format: "uint64",
  };
  const alignedValue: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 16,
    align: 16,
    format: "{ uint64 }",
    fields: [
      {
        name: "value",
        offset: 0,
        size: 8,
        type: uint64Type,
      },
    ],
  };
  const buf = new Uint8Array(160);
  buf.set(i64(0), 56); // PoV0.bstRootIndex
  buf.set(le(flags([0])), 64);
  buf.set(le(7n), 80); // flags end at 72; alignas(16) element begins at 80
  buf.set(i64(3), 96); // priority follows the 16-byte value
  buf.set(i64(-1), 112);
  buf.set(i64(-1), 120);
  buf.set(i64(-1), 128);

  const entries = await decodeCollection(buf, alignedValue, 1);
  expect(entries.map((entry) => [entry.value, entry.priority])).toEqual([[7n, 3n]]);
});

test("flags spanning >32 slots use the second flag word", async () => {
  const cap = 64; // 2 flag words; slot 33 -> word 1, bit 2
  const buf = new Uint8Array(cap * 16 + 16);
  buf.set(le(7n), 33 * 16);
  buf.set(le(70n), 33 * 16 + 8);
  buf.set(le(flags([1])), cap * 16 + 8); // word1 (slots 32..63): slot33 -> (33&31)*2=2
  expect(await decodeHashMap(buf, "uint64", "uint64", cap)).toEqual([
    { slot: 33, key: 7n, value: 70n },
  ]);
});

test("flags spanning a THIRD word (cap 96, slot 70)", async () => {
  const cap = 96; // ceil(192/64)=3 flag words; slot 70 -> word 2
  const buf = new Uint8Array(cap * 16 + 24);
  buf.set(le(5n), 70 * 16);
  buf.set(le(9n), 70 * 16 + 8);
  buf.set(le(flags([70])), cap * 16 + 2 * 8); // word2 (slots 64..95): (70&31)*2=12
  expect(await decodeHashMap(buf, "uint64", "uint64", cap)).toEqual([
    { slot: 70, key: 5n, value: 9n },
  ]);
});

test("HashMap with a struct-typed value decodes the value as a tuple", async () => {
  const buf = new Uint8Array(2 * 16 + 16); // element {uint64, {uint32,uint32}} stride 16
  buf.set(le(5n), 0);
  buf.set(le(11n).slice(0, 4), 8);
  buf.set(le(22n).slice(0, 4), 12);
  buf.set(le(flags([0])), 32);
  expect(await decodeHashMap(buf, "uint64", "{ uint32, uint32 }", 2)).toEqual([
    { slot: 0, key: 5n, value: [11, 22] },
  ]);
});

test("HashSet excludes marked-for-removal slots (10)", async () => {
  const buf = new Uint8Array(4 * 8 + 8);
  buf.set(le(11n), 0);
  buf.set(le(22n), 8); // slot0 occupied, slot1 removed
  buf.set(le(flags([0], [1])), 32);
  expect(await decodeHashSet(buf, "uint64", 4)).toEqual([{ slot: 0, key: 11n }]);
});

test("decoders are OOB-safe: capacity beyond the buffer -> no entries, no throw", async () => {
  expect(await decodeHashMap(new Uint8Array(16), "uint64", "uint64", 100)).toEqual([]);
  expect(await decodeHashSet(new Uint8Array(16), "uint64", 100)).toEqual([]);
  expect(await decodeCollection(new Uint8Array(16), "uint64", 100)).toEqual([]);
});

test("Collection: two occupied PoVs each yield their own entry", async () => {
  const cap = 4,
    povStride = 64,
    flagsOff = cap * povStride,
    elemsOff = flagsOff + 8,
    es = 48;
  const buf = new Uint8Array(elemsOff + cap * es + 16);
  buf.set(i64(0), 56); // PoV0.bstRoot = elem0
  buf[64] = 1;
  buf.set(i64(1), 64 + 56); // PoV1 id distinct, bstRoot = elem1
  buf.set(le(flags([0, 1])), flagsOff); // PoVs 0 and 1 occupied
  const E = (off: number, value: number, prio: number, pov: number) => {
    buf.set(i64(value), off);
    buf.set(i64(prio), off + 8);
    buf.set(i64(pov), off + 16);
    buf.set(i64(-1), off + 24);
    buf.set(i64(-1), off + 32);
    buf.set(i64(-1), off + 40); // parent,left,right = none
  };
  E(elemsOff + 0, 10, 1, 0);
  E(elemsOff + 48, 20, 2, 1);
  const e = await decodeCollection(buf, "uint64", cap);
  expect(e.map((x) => x.value)).toEqual([10n, 20n]);
  expect(e[0].pov).not.toBe(e[1].pov); // different PoV identities
});

test("Collection: a cyclic BST (left = self) terminates via the guard, no hang", async () => {
  const cap = 4,
    elemsOff = cap * 64 + 8;
  const buf = new Uint8Array(elemsOff + cap * 48 + 16);
  buf.set(i64(0), 56);
  buf.set(le(1n), cap * 64); // PoV0 occupied, bstRoot=0
  buf.set(i64(7), elemsOff);
  buf.set(i64(1), elemsOff + 8); // elem0 value=7
  buf.set(i64(0), elemsOff + 32);
  buf.set(i64(-1), elemsOff + 40); // left=0 (self cycle!), right=none
  const e = await decodeCollection(buf, "uint64", cap);
  expect(Array.isArray(e)).toBe(true);
  expect(e.length).toBeLessThanOrEqual(cap * 2 + 4); // bounded by the guard, did not loop forever
});

function linkedListFixture(
  occupied: number[],
  links: Array<[slot: number, value: number, next: number, previous: number]>,
  head: number,
  tail: number,
  population = occupied.length,
): Uint8Array {
  const capacity = 8;
  const geometry = linkedListGeometry({ size: 8, align: 8 }, capacity);
  const buf = new Uint8Array(geometry.size);
  for (const [slot, value, next, previous] of links) {
    const nodeOffset = slot * geometry.nodeStride;
    buf.set(le(BigInt(value)), nodeOffset);
    buf.set(i64(next), nodeOffset + geometry.nextOffset);
    buf.set(i64(previous), nodeOffset + geometry.prevOffset);
  }
  for (const slot of occupied) {
    buf[geometry.flagsOffset + (slot >> 3)] |= 1 << (slot & 7);
  }
  buf.set(i64(head), geometry.headOffset);
  buf.set(i64(tail), geometry.tailOffset);
  buf.set(le(BigInt(population)), geometry.populationOffset);
  return buf;
}

test("LinkedList follows links rather than reused slot order", async () => {
  const buf = linkedListFixture(
    [1, 5, 7],
    [
      [5, 50, 1, -1],
      [1, 10, 7, 5],
      [7, 70, -1, 1],
    ],
    5,
    7,
  );
  expect(await decodeLinkedList(buf, "uint64", 8)).toEqual([
    { slot: 5, value: 50n },
    { slot: 1, value: 10n },
    { slot: 7, value: 70n },
  ]);
});

test("LinkedList accepts the zero-filled empty state before reading sentinels", async () => {
  const geometry = linkedListGeometry({ size: 8, align: 8 }, 8);
  expect(
    await decodeLinkedList(new Uint8Array(geometry.size), "uint64", 8),
  ).toEqual([]);
});

test("LinkedList rejects malformed topology", async () => {
  const valid = () => linkedListFixture(
    [1, 5],
    [
      [5, 50, 1, -1],
      [1, 10, -1, 5],
    ],
    5,
    1,
  );
  const geometry = linkedListGeometry({ size: 8, align: 8 }, 8);

  const badPopulation = valid();
  badPopulation.set(le(3n), geometry.populationOffset);
  await expect(
    decodeLinkedList(badPopulation, "uint64", 8),
  ).rejects.toThrow(/occupied slots.*population/);

  const badPrevious = valid();
  badPrevious.set(i64(7), 1 * geometry.nodeStride + geometry.prevOffset);
  await expect(
    decodeLinkedList(badPrevious, "uint64", 8),
  ).rejects.toThrow(/has prev/);

  const cycle = linkedListFixture(
    [1, 5, 7],
    [
      [5, 50, 1, -1],
      [1, 10, 5, 5],
      [7, 70, -1, -1],
    ],
    5,
    7,
  );
  await expect(decodeLinkedList(cycle, "uint64", 8)).rejects.toThrow(
    /cycle repeats slot/,
  );

  const badHead = valid();
  badHead.set(i64(0), geometry.headOffset);
  await expect(decodeLinkedList(badHead, "uint64", 8)).rejects.toThrow(
    /head and tail must be occupied/,
  );

  const badTail = valid();
  badTail.set(i64(5), geometry.tailOffset);
  await expect(decodeLinkedList(badTail, "uint64", 8)).rejects.toThrow(
    /expected tail/,
  );

  const unreachable = linkedListFixture(
    [1, 5],
    [
      [5, 50, -1, -1],
      [1, 10, -1, -1],
    ],
    5,
    5,
  );
  await expect(decodeLinkedList(unreachable, "uint64", 8)).rejects.toThrow(
    /invalid next index/,
  );
});
