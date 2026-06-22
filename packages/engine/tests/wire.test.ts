// Typed wire-struct views (wire.ts) — the SIZE constants match the C++ sizeof, every field round-trips through
// its offset, the views are zero-copy (writes reach the backing buffer), and m256i exposes id/digest helpers.
import { test, expect } from "bun:test";
import {
  M256i, RequestResponseHeader, EntityRecord, AssetRecord, Tick, TickData, Transaction, ASSET_TYPE,
} from "../src/wire";

test("SIZE constants equal the C++ sizeof", () => {
  expect(RequestResponseHeader.SIZE).toBe(8);
  expect(EntityRecord.SIZE).toBe(64);
  expect(AssetRecord.SIZE).toBe(48);
  expect(Tick.SIZE).toBe(352);
  expect(TickData.SIZE).toBe(139376);
  expect(Transaction.HEADER_SIZE).toBe(80);
});

test("M256i: hex round-trip, u64 lanes, isZero, equals", () => {
  const z = M256i.zero();
  expect(z.isZero()).toBe(true);

  const hex = "00112233445566778899aabbccddeeff" + "ffeeddccbbaa99887766554433221100";
  const m = M256i.from(hex);
  expect(m.hex).toBe(hex);
  expect(m.isZero()).toBe(false);
  expect(m.u64(0)).toBe(0x7766554433221100n); // first 8 bytes LE
  m.setU64(0, 0n);
  expect(m.u64(0)).toBe(0n);

  const a = M256i.from(new Uint8Array(32).fill(7));
  expect(a.equals(new Uint8Array(32).fill(7))).toBe(true);
  expect(a.equals(new Uint8Array(32).fill(8))).toBe(false);
});

test("EntityRecord: every field round-trips at its offset", () => {
  const r = EntityRecord.alloc();
  r.publicKey = new Uint8Array(32).fill(0xab);
  r.incomingAmount = 1000n;
  r.outgoingAmount = 250n;
  r.numberOfIncomingTransfers = 3;
  r.numberOfOutgoingTransfers = 1;
  r.latestIncomingTransferTick = 7;
  r.latestOutgoingTransferTick = 5;

  const dv = new DataView(r.bytes.buffer);
  expect(dv.getBigInt64(32, true)).toBe(1000n);
  expect(dv.getUint32(48, true)).toBe(3);

  const back = EntityRecord.wrap(r.bytes);
  expect(back.publicKey.hex).toBe("ab".repeat(32));
  expect(back.incomingAmount).toBe(1000n);
  expect(back.latestOutgoingTransferTick).toBe(5);
});

test("AssetRecord: ownership + issuance variants, incl. the @36 issuanceIndex", () => {
  const own = AssetRecord.alloc();
  own.publicKey = new Uint8Array(32).fill(0x22);
  own.type = ASSET_TYPE.OWNERSHIP;
  own.managingContractIndex = 29;
  own.issuanceIndex = 42; // the @36 field the old encoder never named
  own.numberOfShares = 5000n;

  expect(own.bytes[32]).toBe(2);
  expect(new DataView(own.bytes.buffer).getUint32(36, true)).toBe(42);
  expect(own.managingContractIndex).toBe(29);
  expect(own.numberOfShares).toBe(5000n);
  expect(own.ownershipIndex).toBe(42); // alias of @36

  const iss = AssetRecord.alloc();
  iss.type = ASSET_TYPE.ISSUANCE;
  iss.nameString = "QTOKEN";
  iss.numberOfDecimalPlaces = 2;
  expect(iss.nameString).toBe("QTOKEN");
  expect(iss.bytes[40]).toBe(2);
});

test("Tick: header, the @16 resource-testing digest, and the m256 digest fields", () => {
  const t = Tick.alloc();
  t.computorIndex = 5;
  t.epoch = 2;
  t.tick = 123;
  t.prevResourceTestingDigest = 0xdeadbeef; // @16 — surfaced by the struct, zeroed by the encoder
  t.prevSpectrumDigest = new Uint8Array(32).fill(0x11);
  t.transactionDigest = new Uint8Array(32).fill(0x22);

  expect(new DataView(t.bytes.buffer).getUint32(16, true)).toBe(0xdeadbeef);
  expect(t.prevSpectrumDigest.hex).toBe("11".repeat(32));   // @32
  expect(t.transactionDigest.hex).toBe("22".repeat(32));    // @224
  expect(t.tick).toBe(123);
});

test("TickData: header, timelock, indexed digests/fees, signature", () => {
  const td = TickData.alloc();
  td.tick = 124;
  td.epoch = 3;
  td.timelock = new Uint8Array(32).fill(0x33);
  td.setTxDigest(0, new Uint8Array(32).fill(0xa1));
  td.setTxDigest(4095, new Uint8Array(32).fill(0xa2));
  td.setContractFee(1, 777n);
  td.signature = new Uint8Array(64).fill(0x55);

  expect(td.bytes.length).toBe(139376);
  expect(td.timelock.hex).toBe("33".repeat(32));        // @16
  expect(td.txDigest(0).hex).toBe("a1".repeat(32));     // @48
  expect(td.txDigest(4095).hex).toBe("a2".repeat(32));  // last digest
  expect(td.contractFee(1)).toBe(777n);
  expect(td.signature[0]).toBe(0x55);                   // @139312
});

test("RequestResponseHeader: the 3-byte (u24) size field", () => {
  const h = RequestResponseHeader.alloc();
  h.size = 0x123456; // exceeds 16 bits — must round-trip through 3 bytes
  h.type = 32;
  h.dejavu = 0xdeadbeef;

  expect(h.size).toBe(0x123456);
  expect(h.bytes[0]).toBe(0x56);
  expect(h.bytes[1]).toBe(0x34);
  expect(h.bytes[2]).toBe(0x12);
  expect(h.type).toBe(32);
  expect(h.dejavu).toBe(0xdeadbeef);
});

test("Transaction: wrap reads header + variable input + signature; views are zero-copy", () => {
  const inputSize = 3;
  const buf = new Uint8Array(Transaction.HEADER_SIZE + inputSize + 64);
  const tx = Transaction.wrap(buf);
  tx.sourcePublicKey = new Uint8Array(32).fill(0x01);
  tx.destinationPublicKey = new Uint8Array(32).fill(0x02);
  tx.amount = 9000n;
  tx.tick = 50;
  tx.inputType = 1;
  tx.inputSize = inputSize;
  tx.input.set([9, 8, 7]);
  tx.signature.set(new Uint8Array(64).fill(0x77));

  // zero-copy: the writes landed in the backing buffer
  const re = Transaction.wrap(buf);
  expect(re.amount).toBe(9000n);
  expect(re.inputType).toBe(1);
  expect(Array.from(re.input)).toEqual([9, 8, 7]);
  expect(re.signature[0]).toBe(0x77);
  expect(re.sourcePublicKey.equals(new Uint8Array(32).fill(0x01))).toBe(true);
});
