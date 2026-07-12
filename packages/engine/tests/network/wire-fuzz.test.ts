// Generative round-trip + layout fuzz over the wire views (wire.ts). The fixed vectors in wire.test.ts pin a few
// known offsets by hand; this sweeps every defineStruct field with random values to catch any getter/setter
import { test, expect } from "bun:test";
import {
  M256i, RequestResponseHeader, EntityRecord, Tick, TickData, Transaction, AssetRecord,
  RequestTickData, RequestContractFunction, RespondCurrentTickInfo, RespondSystemInfo,
  RespondEntity, RespondOwnedAssets, RespondPossessedAssets, RespondTxStatusHeader,
  DIGEST_SIZE, SIG_SIZE, TXS_PER_TICK, CONTRACT_FEES_COUNT, SPECTRUM_DEPTH, ASSETS_DEPTH,
} from "../../src/wire";
import { bytesEqual } from "../../src/bytes";

const TRIALS = 64;

// ---- a tiny deterministic PRNG (mulberry32) so a failing random case is reproducible from its seed ----
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(name: string): number {
  let h = 0x9e3779b1;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

function randBig(r: () => number): bigint {
  const hi = BigInt(Math.floor(r() * 0x100000000));
  const lo = BigInt(Math.floor(r() * 0x100000000));
  return (hi << 32n) | lo;
}

function randBytes(r: () => number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = Math.floor(r() * 256);
  }
  return b;
}

// ---- the field-kind model: each defineStruct field is described independently of wire.ts (so the test is not
// circular with the layout it checks). `arr`/`sub` carry the element count / embedded class. ----
interface SubClass {
  SIZE: number;
  alloc(): { bytes: Uint8Array };
  wrap(buf: Uint8Array, off?: number): { bytes: Uint8Array };
}

type Kind =
  | "u8" | "u16" | "u24" | "u32" | "i16" | "i32" | "i64" | "u64" | "m256"
  | { blob: number }
  | { arr: "m256" | "i64"; n: number }
  | { sub: SubClass };

function sizeOf(k: Kind): number {
  if (typeof k === "string") {
    const sizes: Record<string, number> = { u8: 1, u16: 2, u24: 3, u32: 4, i16: 2, i32: 4, i64: 8, u64: 8, m256: 32 };
    return sizes[k];
  }
  if ("blob" in k) {
    return k.blob;
  }
  if ("arr" in k) {
    return (k.arr === "m256" ? DIGEST_SIZE : 8) * k.n;
  }
  return k.sub.SIZE;
}

function alignOf(k: Kind): number {
  if (typeof k === "string") {
    const aligns: Record<string, number> = { u8: 1, u16: 2, u24: 1, u32: 4, i16: 2, i32: 4, i64: 8, u64: 8, m256: 8 };
    return aligns[k];
  }
  if ("blob" in k) {
    return 1;
  }
  if ("arr" in k) {
    return 8; // m256 and i64 elements are both 8-aligned
  }
  return 8; // the embedded Qubic structs are 8-aligned
}

// A few array indices worth probing: always the two endpoints, plus some random interior slots.
function sampleIndices(n: number, r: () => number): number[] {
  const s = new Set<number>([0, n - 1]);
  const extra = Math.min(6, n);
  for (let i = 0; i < extra; i++) {
    s.add(Math.floor(r() * n));
  }
  return [...s];
}

// Write a random value into `view[name]` and return a checker that asserts a re-wrapped view reads it back.
function fuzzField(view: Record<string, unknown>, name: string, k: Kind, r: () => number): (v2: Record<string, unknown>) => void {
  if (k === "u8" || k === "u16" || k === "u24" || k === "u32") {
    const span = { u8: 0x100, u16: 0x10000, u24: 0x1000000, u32: 0x100000000 }[k];
    const x = Math.floor(r() * span);
    view[name] = x;
    return (v2) => expect(v2[name]).toBe(x);
  }
  if (k === "i16") {
    const x = Math.floor(r() * 0x10000) - 0x8000;
    view[name] = x;
    return (v2) => expect(v2[name]).toBe(x);
  }
  if (k === "i32") {
    const x = Math.floor(r() * 0x100000000) | 0;
    view[name] = x;
    return (v2) => expect(v2[name]).toBe(x);
  }
  if (k === "i64") {
    const x = BigInt.asIntN(64, randBig(r));
    view[name] = x;
    return (v2) => expect(v2[name]).toBe(x);
  }
  if (k === "u64") {
    const x = randBig(r);
    view[name] = x;
    return (v2) => expect(v2[name]).toBe(x);
  }
  if (k === "m256") {
    const b = randBytes(r, DIGEST_SIZE);
    view[name] = M256i.from(b);
    return (v2) => expect(bytesEqual((v2[name] as M256i).bytes, b)).toBe(true);
  }
  if ("blob" in k) {
    const b = randBytes(r, k.blob);
    view[name] = b;
    return (v2) => expect(bytesEqual(v2[name] as Uint8Array, b)).toBe(true);
  }
  if ("arr" in k) {
    const arr = view[name] as { set(i: number, v: unknown): void };
    const idxs = sampleIndices(k.n, r);
    const vals = new Map<number, Uint8Array | bigint>();
    for (const i of idxs) {
      if (k.arr === "m256") {
        const b = randBytes(r, DIGEST_SIZE);
        arr.set(i, b);
        vals.set(i, b);
      } else {
        const x = BigInt.asIntN(64, randBig(r));
        arr.set(i, x);
        vals.set(i, x);
      }
    }
    return (v2) => {
      const got = v2[name] as { at(i: number): unknown };
      for (const [i, val] of vals) {
        if (val instanceof Uint8Array) {
          expect(bytesEqual((got.at(i) as M256i).bytes, val)).toBe(true);
        } else {
          expect(got.at(i)).toBe(val);
        }
      }
    };
  }

  const b = randBytes(r, k.sub.SIZE);
  const inst = k.sub.alloc();
  inst.bytes.set(b);
  view[name] = inst;
  return (v2) => expect(bytesEqual((v2[name] as { bytes: Uint8Array }).bytes, b)).toBe(true);
}

// Fill a field with a max non-zero value — used by the padding test so every covered byte is non-zero and any
// remaining zero byte must be alignment padding.
function saturate(view: Record<string, unknown>, name: string, k: Kind): void {
  if (k === "u8") {
    view[name] = 0xff;
  } else if (k === "u16") {
    view[name] = 0xffff;
  } else if (k === "u24") {
    view[name] = 0xffffff;
  } else if (k === "u32") {
    view[name] = 0xffffffff;
  } else if (k === "i16" || k === "i32") {
    view[name] = -1;
  } else if (k === "i64") {
    view[name] = -1n;
  } else if (k === "u64") {
    view[name] = 0xffffffffffffffffn;
  } else if (k === "m256") {
    view[name] = M256i.from(new Uint8Array(DIGEST_SIZE).fill(0xff));
  } else if ("blob" in k) {
    view[name] = new Uint8Array(k.blob).fill(0xff);
  } else if ("arr" in k) {
    const arr = view[name] as { set(i: number, v: unknown): void };
    for (let i = 0; i < k.n; i++) {
      arr.set(i, k.arr === "m256" ? new Uint8Array(DIGEST_SIZE).fill(0xff) : -1n);
    }
  } else {
    const inst = k.sub.alloc();
    inst.bytes.fill(0xff);
    view[name] = inst;
  }
}

// ---- the defineStruct inventory: each field's kind, declared here independently of wire.ts ----
interface StructSpec {
  name: string;
  klass: { SIZE: number; OFFSETS: Record<string, number>; alloc(): { bytes: Uint8Array }; wrap(buf: Uint8Array, off?: number): Record<string, unknown> };
  fields: Record<string, Kind>;
  packed?: boolean;
}

const STRUCTS: StructSpec[] = [
  {
    name: "RequestResponseHeader",
    klass: RequestResponseHeader as never,
    fields: { size: "u24", type: "u8", dejavu: "u32" },
  },
  {
    name: "EntityRecord",
    klass: EntityRecord as never,
    fields: {
      publicKey: "m256", incomingAmount: "i64", outgoingAmount: "i64",
      numberOfIncomingTransfers: "u32", numberOfOutgoingTransfers: "u32",
      latestIncomingTransferTick: "u32", latestOutgoingTransferTick: "u32",
    },
  },
  {
    name: "Tick",
    klass: Tick as never,
    fields: {
      computorIndex: "u16", epoch: "u16", tick: "u32", millisecond: "u16",
      second: "u8", minute: "u8", hour: "u8", day: "u8", month: "u8", year: "u8",
      prevResourceTestingDigest: "u32", saltedResourceTestingDigest: "u32",
      prevTransactionBodyDigest: "u32", saltedTransactionBodyDigest: "u32",
      prevSpectrumDigest: "m256", prevUniverseDigest: "m256", prevComputerDigest: "m256",
      saltedSpectrumDigest: "m256", saltedUniverseDigest: "m256", saltedComputerDigest: "m256",
      transactionDigest: "m256", expectedNextTickTransactionDigest: "m256",
      signature: { blob: SIG_SIZE },
    },
  },
  {
    name: "TickData",
    klass: TickData as never,
    fields: {
      computorIndex: "u16", epoch: "u16", tick: "u32", millisecond: "u16",
      second: "u8", minute: "u8", hour: "u8", day: "u8", month: "u8", year: "u8",
      timelock: "m256",
      txDigests: { arr: "m256", n: TXS_PER_TICK },
      contractFees: { arr: "i64", n: CONTRACT_FEES_COUNT },
      signature: { blob: SIG_SIZE },
    },
  },
  {
    name: "RequestTickData",
    klass: RequestTickData as never,
    fields: { tick: "u32" },
  },
  {
    name: "RequestContractFunction",
    klass: RequestContractFunction as never,
    fields: { contractIndex: "u32", inputType: "u16", inputSize: "u16" },
  },
  {
    name: "RespondCurrentTickInfo",
    klass: RespondCurrentTickInfo as never,
    fields: {
      tickDuration: "u16", epoch: "u16", tick: "u32",
      numberOfAlignedVotes: "u16", numberOfMisalignedVotes: "u16", initialTick: "u32",
    },
  },
  {
    name: "RespondSystemInfo",
    klass: RespondSystemInfo as never,
    packed: true,
    fields: {
      version: "i16", epoch: "u16", tick: "u32", initialTick: "u32", latestCreatedTick: "u32",
      initialMillisecond: "u16", initialSecond: "u8", initialMinute: "u8", initialHour: "u8",
      initialDay: "u8", initialMonth: "u8", initialYear: "u8",
      numberOfEntities: "u32", numberOfTransactions: "u32", randomMiningSeed: "m256",
      solutionThreshold: "i32", totalSpectrumAmount: "u64", currentEntityBalanceDustThreshold: "u64",
      targetTickVoteSignature: "u32", computorPacketSignature: "u64", solutionAdditionalThreshold: "u64",
      _reserve2: "u64", _reserve3: "u64", _reserve4: "u64",
    },
  },
  {
    name: "RespondEntity",
    klass: RespondEntity as never,
    fields: {
      entity: { sub: EntityRecord as never }, tick: "u32", spectrumIndex: "i32",
      siblings: { arr: "m256", n: SPECTRUM_DEPTH },
    },
  },
  {
    name: "RespondOwnedAssets",
    klass: RespondOwnedAssets as never,
    fields: {
      asset: { sub: AssetRecord as never }, issuanceAsset: { sub: AssetRecord as never },
      tick: "u32", universeIndex: "u32", siblings: { arr: "m256", n: ASSETS_DEPTH },
    },
  },
  {
    name: "RespondPossessedAssets",
    klass: RespondPossessedAssets as never,
    fields: {
      asset: { sub: AssetRecord as never }, ownershipAsset: { sub: AssetRecord as never },
      issuanceAsset: { sub: AssetRecord as never }, tick: "u32", universeIndex: "u32",
      siblings: { arr: "m256", n: ASSETS_DEPTH },
    },
  },
  {
    name: "RespondTxStatusHeader",
    klass: RespondTxStatusHeader as never,
    fields: { currentTick: "u32", tick: "u32", txCount: "u32" },
  },
];

// ---- (1) every field written through the setters reads back identically from an independent re-wrap ----
for (const s of STRUCTS) {
  test(`${s.name}: random field values round-trip through a re-wrapped buffer`, () => {
    const r = rng(seedOf(s.name));
    for (let trial = 0; trial < TRIALS; trial++) {
      const view = s.klass.alloc() as unknown as Record<string, unknown>;
      const checks: ((v2: Record<string, unknown>) => void)[] = [];
      for (const [name, k] of Object.entries(s.fields)) {
        checks.push(fuzzField(view, name, k, r));
      }

      const copy = (view as unknown as { bytes: Uint8Array }).bytes.slice();
      const v2 = s.klass.wrap(copy) as unknown as Record<string, unknown>;
      for (const check of checks) {
        check(v2);
      }
    }
  });
}

// ---- (2) the derived layout: offsets are aligned, fields never overlap, and the only bytes left zero after
// saturating every field are the C compiler's alignment padding ----
for (const s of STRUCTS) {
  test(`${s.name}: derived offsets are aligned + non-overlapping, padding stays zero`, () => {
    const SIZE = s.klass.SIZE;
    const off = s.klass.OFFSETS;
    const covered = new Uint8Array(SIZE);
    let maxAlign = 1;
    let bareSum = 0;

    for (const [name, k] of Object.entries(s.fields)) {
      const o = off[name];
      const sz = sizeOf(k);
      bareSum += sz;
      expect(o + sz).toBeLessThanOrEqual(SIZE);
      if (!s.packed) {
        expect(o % alignOf(k)).toBe(0);
      }
      if (alignOf(k) > maxAlign) {
        maxAlign = alignOf(k);
      }

      for (let i = o; i < o + sz; i++) {
        expect(covered[i]).toBe(0); // no two fields share a byte
        covered[i] = 1;
      }
    }

    if (s.packed) {
      expect(SIZE).toBe(bareSum); // #pragma pack(1): no padding at all
    } else {
      expect(SIZE % maxAlign).toBe(0); // trailing pad to the struct's alignment
    }

    const view = s.klass.alloc() as unknown as Record<string, unknown>;
    for (const [name, k] of Object.entries(s.fields)) {
      saturate(view, name, k);
    }

    const bytes = (view as unknown as { bytes: Uint8Array }).bytes;
    for (let i = 0; i < SIZE; i++) {
      if (covered[i] === 0) {
        expect(bytes[i]).toBe(0); // an uncovered byte can only be alignment padding
      }
    }
  });
}

// ---- (3) TickData's derived signature offset is the body boundary the leader signs ----
test("TickData.SIG_OFFSET marks the signature field, with a 64-byte signature tail", () => {
  expect(TickData.SIG_OFFSET).toBe(TickData.OFFSETS.signature);
  expect(TickData.SIZE - TickData.SIG_OFFSET).toBe(SIG_SIZE);
});

// ---- (4) M256i primitive: bytes/hex round-trip, the four 64-bit lanes, equals/isZero ----
test("M256i: from(bytes)/from(hex) round-trip, u64 lanes, equals/isZero over random values", () => {
  const r = rng(seedOf("M256i"));
  for (let trial = 0; trial < TRIALS * 2; trial++) {
    const b = randBytes(r, DIGEST_SIZE);
    const m = M256i.from(b);
    expect(bytesEqual(m.bytes, b)).toBe(true);
    expect(bytesEqual(M256i.from(m.hex).bytes, b)).toBe(true);
    expect(m.equals(b)).toBe(true);

    const dv = new DataView(b.buffer, b.byteOffset, DIGEST_SIZE);
    for (let lane = 0; lane < 4; lane++) {
      expect(m.u64(lane)).toBe(dv.getBigUint64(lane * 8, true));
    }
  }

  expect(M256i.alloc().isZero()).toBe(true);
  expect(M256i.from(new Uint8Array(DIGEST_SIZE).fill(1)).isZero()).toBe(false);
});

// ---- (5) AssetRecord union: each variant's fields round-trip at their derived offsets ----
function randName(r: () => number): string {
  const len = 1 + Math.floor(r() * 7);
  let s = "";
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(65 + Math.floor(r() * 26));
  }
  return s;
}

test("AssetRecord issuance variant: publicKey/type/name/decimals round-trip", () => {
  const r = rng(seedOf("AssetIssuance"));
  for (let trial = 0; trial < TRIALS; trial++) {
    const a = AssetRecord.alloc();
    const pk = randBytes(r, DIGEST_SIZE);
    const name = randName(r);
    const dec = Math.floor(r() * 256);
    a.publicKey = M256i.from(pk);
    a.type = 1;
    a.nameString = name;
    a.numberOfDecimalPlaces = dec;

    const a2 = AssetRecord.wrap(a.bytes.slice());
    expect(bytesEqual(a2.publicKey.bytes, pk)).toBe(true);
    expect(a2.type).toBe(1);
    expect(a2.nameString).toBe(name);
    expect(a2.numberOfDecimalPlaces).toBe(dec);
  }
});

test("AssetRecord ownership/possession variant: managingContractIndex/index/shares round-trip", () => {
  const r = rng(seedOf("AssetOwnership"));
  for (let trial = 0; trial < TRIALS; trial++) {
    const a = AssetRecord.alloc();
    const pk = randBytes(r, DIGEST_SIZE);
    const mci = Math.floor(r() * 0x10000);
    const idx = Math.floor(r() * 0x100000000) >>> 0;
    const shares = BigInt.asIntN(64, randBig(r));
    a.publicKey = M256i.from(pk);
    a.type = 2;
    a.managingContractIndex = mci;
    a.ownershipIndex = idx;
    a.numberOfShares = shares;

    const a2 = AssetRecord.wrap(a.bytes.slice());
    expect(bytesEqual(a2.publicKey.bytes, pk)).toBe(true);
    expect(a2.managingContractIndex).toBe(mci);
    expect(a2.ownershipIndex).toBe(idx);
    expect(a2.issuanceIndex).toBe(idx); // ownership.index and possession.index alias the same u32
    expect(a2.numberOfShares).toBe(shares);
  }
});

// ---- (6) Transaction: the 80-byte header plus the variable input[inputSize] + signature[64] tail ----
test("Transaction: header fields + input/signature slicing round-trip for random inputSize", () => {
  const r = rng(seedOf("Transaction"));
  for (let trial = 0; trial < TRIALS; trial++) {
    const inputSize = Math.floor(r() * 64);
    const buf = new Uint8Array(Transaction.HEADER_SIZE + inputSize + SIG_SIZE);
    const tx = Transaction.wrap(buf);
    const src = randBytes(r, DIGEST_SIZE);
    const dst = randBytes(r, DIGEST_SIZE);
    const amount = BigInt.asIntN(64, randBig(r));
    const tick = Math.floor(r() * 0x100000000) >>> 0;
    const inputType = Math.floor(r() * 0x10000);
    const input = randBytes(r, inputSize);
    const sig = randBytes(r, SIG_SIZE);

    tx.sourcePublicKey = M256i.from(src);
    tx.destinationPublicKey = M256i.from(dst);
    tx.amount = amount;
    tx.tick = tick;
    tx.inputType = inputType;
    tx.inputSize = inputSize;
    tx.input.set(input);
    tx.signature.set(sig);

    const tx2 = Transaction.wrap(buf.slice());
    expect(bytesEqual(tx2.sourcePublicKey.bytes, src)).toBe(true);
    expect(bytesEqual(tx2.destinationPublicKey.bytes, dst)).toBe(true);
    expect(tx2.amount).toBe(amount);
    expect(tx2.tick).toBe(tick);
    expect(tx2.inputType).toBe(inputType);
    expect(tx2.inputSize).toBe(inputSize);
    expect(bytesEqual(tx2.input, input)).toBe(true);
    expect(bytesEqual(tx2.signature, sig)).toBe(true);
  }
});
