// Typed wire-struct views (wire.ts). The layout is derived by `defineStruct` emulating the C compiler's
// natural-alignment rules, so these tests pin three things: (1) every auto-computed SIZE/offset equals the C++
import { test, expect } from "bun:test";
import {
  M256i,
  RequestResponseHeader,
  EntityRecord,
  AssetRecord,
  Tick,
  TickData,
  Transaction,
  ASSET_TYPE,
  TICKDATA_SIZE,
  ASSET_RECORD_SIZE,
  SPECTRUM_DEPTH,
  ASSETS_DEPTH,
  SIG_SIZE,
  DIGEST_SIZE,
  TXS_PER_TICK,
  CONTRACT_FEES_COUNT,
  RequestTickData,
  RequestContractFunction,
  RespondCurrentTickInfo,
  RespondSystemInfo,
  RespondEntity,
  RespondOwnedAssets,
  RespondPossessedAssets,
  RespondTxStatusHeader,
} from "../../src/wire";

// A DataView over a view's own window — used to read fields at their raw offset, independent of the getters.
function dvOf(v: { bytes: Uint8Array }): DataView {
  return new DataView(v.bytes.buffer, v.bytes.byteOffset, v.bytes.byteLength);
}

test("SIZE equals the C++ sizeof (auto-summed with alignment padding)", () => {
  expect(RequestResponseHeader.SIZE).toBe(8); // header.h
  expect(EntityRecord.SIZE).toBe(64); // entity.h: 32 + 2*8 + 2*4 + 2*4
  expect(AssetRecord.SIZE).toBe(48); // assets.h: 32 + 1 + 1 + 2 + 4 + 8 (ownership)
  expect(Tick.SIZE).toBe(352); // tick.h: 8 + 8 + 2*4 + 2*4 + 6*32 + 2*32 + 64
  expect(TickData.SIZE).toBe(139376); // tick.h: 8 + 8 + 32 + 4096*32 + 1024*8 + 64
  expect(Transaction.HEADER_SIZE).toBe(80); // transactions.h: 32 + 32 + 8 + 4 + 2 + 2
});

test("derived OFFSETS match the C++ field offsets", () => {
  expect(RequestResponseHeader.OFFSETS).toMatchObject({ size: 0, type: 3, dejavu: 4 });
  expect(EntityRecord.OFFSETS).toMatchObject({
    publicKey: 0,
    incomingAmount: 32,
    outgoingAmount: 40,
    numberOfIncomingTransfers: 48,
    numberOfOutgoingTransfers: 52,
    latestIncomingTransferTick: 56,
    latestOutgoingTransferTick: 60,
  });
  expect(Tick.OFFSETS).toMatchObject({
    prevResourceTestingDigest: 16,
    saltedResourceTestingDigest: 20,
    prevTransactionBodyDigest: 24,
    saltedTransactionBodyDigest: 28,
    prevSpectrumDigest: 32,
    prevUniverseDigest: 64,
    prevComputerDigest: 96,
    saltedSpectrumDigest: 128,
    saltedUniverseDigest: 160,
    saltedComputerDigest: 192,
    transactionDigest: 224,
    expectedNextTickTransactionDigest: 256,
    signature: 288,
  });
  expect(TickData.OFFSETS).toMatchObject({
    timelock: 16,
    txDigests: 48,
    contractFees: 131120,
    signature: 139312,
  });
  expect(TickData.SIG_OFFSET).toBe(139312);
});

test("AssetRecord reproduces the C compiler's alignment pad at @33", () => {
  const own = AssetRecord.alloc();
  own.type = ASSET_TYPE.OWNERSHIP;
  own.managingContractIndex = 0x1234;
  own.issuanceIndex = 0xdeadbeef;
  own.numberOfShares = 123n;

  const dv = dvOf(own);
  expect(own.bytes[32]).toBe(ASSET_TYPE.OWNERSHIP); // type (char @32)
  expect(own.bytes[33]).toBe(0); // char padding[1] — emerges from u16 needing 2-alignment
  expect(dv.getUint16(34, true)).toBe(0x1234); // managingContractIndex @34
  expect(dv.getUint32(36, true)).toBe(0xdeadbeef); // issuanceIndex @36
  expect(dv.getBigInt64(40, true)).toBe(123n); // numberOfShares @40
});

test("M256i: full id/digest API", () => {
  const z = M256i.zero();
  expect(z.isZero()).toBe(true);
  expect(M256i.alloc().bytes).not.toBe(z.bytes); // fresh, distinct buffers

  const hex = "00112233445566778899aabbccddeeff" + "ffeeddccbbaa99887766554433221100";
  const m = M256i.from(hex);
  expect(m.hex).toBe(hex);
  expect(m.isZero()).toBe(false);
  expect(m.u64(0)).toBe(0x7766554433221100n); // first lane, LE

  m.setU64(0, 1n);
  m.setU64(1, 2n);
  m.setU64(2, 3n);
  m.setU64(3, 4n);
  expect([m.u64(0), m.u64(1), m.u64(2), m.u64(3)]).toEqual([1n, 2n, 3n, 4n]);

  const fromLong = M256i.from(new Uint8Array(40).fill(0xcd)); // clamps to 32
  expect(fromLong.bytes.length).toBe(DIGEST_SIZE);
  expect(fromLong.hex).toBe("cd".repeat(32));

  const a = M256i.alloc();
  a.set(M256i.from("ab".repeat(32))); // set(M256i)
  expect(a.hex).toBe("ab".repeat(32));
  a.set(new Uint8Array(32).fill(0x07)); // set(Uint8Array)
  expect(a.hex).toBe("07".repeat(32));

  expect(a.equals(M256i.from(new Uint8Array(32).fill(0x07)))).toBe(true); // equals(M256i)
  expect(a.equals(new Uint8Array(32).fill(0x07))).toBe(true); // equals(Uint8Array)
  expect(a.equals(new Uint8Array(16).fill(0x07))).toBe(false); // short-array guard
});

test("views are zero-copy at a nonzero wrap offset", () => {
  const big = new Uint8Array(600);
  const t = Tick.wrap(big, 100);
  t.tick = 0xaabbccdd;
  t.transactionDigest = M256i.from(new Uint8Array(32).fill(0x09));

  const dv = new DataView(big.buffer);
  expect(dv.getUint32(100 + 4, true)).toBe(0xaabbccdd); // tick @ struct+4
  expect(big[100 + 224]).toBe(0x09); // transactionDigest @ struct+224

  expect(Tick.wrap(big, 0).tick).toBe(0); // sibling view at another offset is untouched
  expect(Tick.wrap(big, 100).tick).toBe(0xaabbccdd); // a fresh wrap reads the writes back
});

test("m256 getters return live windows, not copies", () => {
  const t = Tick.alloc();
  t.prevSpectrumDigest.setU64(0, 0x1122334455667788n); // mutate through the getter window
  expect(dvOf(t).getBigUint64(32, true)).toBe(0x1122334455667788n);

  const td = TickData.alloc();
  td.txDigests.at(3).setU64(0, 7n);
  expect(td.txDigests.at(3).u64(0)).toBe(7n);
  expect(dvOf(td).getBigUint64(48 + 3 * DIGEST_SIZE, true)).toBe(7n); // @ digests + 3*32

  td.timelock.setU64(0, 9n);
  expect(dvOf(td).getBigUint64(16, true)).toBe(9n);
});

test("RequestResponseHeader: the 3-byte (u24) size field", () => {
  const h = RequestResponseHeader.alloc();
  h.size = 0xffffff; // max u24
  h.type = 32;
  h.dejavu = 0xdeadbeef;

  expect(h.size).toBe(0xffffff);
  expect([h.bytes[0], h.bytes[1], h.bytes[2]]).toEqual([0xff, 0xff, 0xff]); // LE bytes
  expect(h.type).toBe(32);
  expect(h.dejavu).toBe(0xdeadbeef);
});

test("EntityRecord: every field round-trips, signed amounts", () => {
  const r = EntityRecord.alloc();
  r.publicKey = M256i.from(new Uint8Array(32).fill(0xab));
  r.incomingAmount = 1000n;
  r.outgoingAmount = -250n; // i64, signed
  r.numberOfIncomingTransfers = 3;
  r.numberOfOutgoingTransfers = 1;
  r.latestIncomingTransferTick = 7;
  r.latestOutgoingTransferTick = 5;

  const dv = dvOf(r);
  expect(dv.getBigInt64(32, true)).toBe(1000n);
  expect(dv.getBigInt64(40, true)).toBe(-250n);
  expect(dv.getUint32(48, true)).toBe(3);

  const back = EntityRecord.wrap(r.bytes);
  expect(back.publicKey.hex).toBe("ab".repeat(32));
  expect(back.outgoingAmount).toBe(-250n);
  expect(back.latestOutgoingTransferTick).toBe(5);
});

test("AssetRecord: issuance / ownership / possession variants", () => {
  const iss = AssetRecord.alloc();
  iss.type = ASSET_TYPE.ISSUANCE;
  iss.nameString = "TOOLONGNAME"; // > 7 chars — truncates to the 7-byte name field
  expect(iss.nameString).toBe("TOOLONG");
  iss.nameString = "AB"; // stop-at-NUL on read
  expect(iss.nameString).toBe("AB");
  expect(iss.name[2]).toBe(0);
  iss.numberOfDecimalPlaces = 6;
  expect(iss.bytes[40]).toBe(6); // @40
  iss.unitOfMeasurement.set([4, 5]); // window @41
  expect(iss.bytes[41]).toBe(4);

  const own = AssetRecord.alloc();
  own.type = ASSET_TYPE.OWNERSHIP;
  own.managingContractIndex = 29;
  own.issuanceIndex = 42;
  own.numberOfShares = 5000n;
  expect(own.managingContractIndex).toBe(29);
  expect(own.issuanceIndex).toBe(42);
  expect(own.numberOfShares).toBe(5000n);

  const pos = AssetRecord.alloc();
  pos.type = ASSET_TYPE.POSSESSION;
  pos.ownershipIndex = 99; // alias of issuanceIndex @36
  expect(pos.issuanceIndex).toBe(99);
  expect(dvOf(pos).getUint32(36, true)).toBe(99);
});

test("Tick: date fields, the 4 testing-digests, the m256 digests, signature", () => {
  const t = Tick.alloc();
  t.computorIndex = 5;
  t.epoch = 2;
  t.tick = 123;
  t.millisecond = 999;
  t.second = 58;
  t.minute = 59;
  t.hour = 23;
  t.day = 28;
  t.month = 12;
  t.year = 26;
  expect([t.millisecond, t.second, t.minute, t.hour, t.day, t.month, t.year]).toEqual([
    999, 58, 59, 23, 28, 12, 26,
  ]);

  t.prevResourceTestingDigest = 0x11111111;
  t.saltedResourceTestingDigest = 0x22222222;
  t.prevTransactionBodyDigest = 0x33333333;
  t.saltedTransactionBodyDigest = 0x44444444;
  const dv = dvOf(t);
  expect(dv.getUint32(16, true)).toBe(0x11111111);
  expect(dv.getUint32(20, true)).toBe(0x22222222);
  expect(dv.getUint32(24, true)).toBe(0x33333333);
  expect(dv.getUint32(28, true)).toBe(0x44444444);

  const slots: [keyof typeof Tick.OFFSETS, number][] = [
    ["prevSpectrumDigest", 0xa0],
    ["prevUniverseDigest", 0xa1],
    ["prevComputerDigest", 0xa2],
    ["saltedSpectrumDigest", 0xa3],
    ["saltedUniverseDigest", 0xa4],
    ["saltedComputerDigest", 0xa5],
    ["transactionDigest", 0xa6],
    ["expectedNextTickTransactionDigest", 0xa7],
  ];
  for (const [field, fill] of slots) {
    (t as any)[field] = M256i.from(new Uint8Array(32).fill(fill));
  }
  for (const [field, fill] of slots) {
    expect((t as any)[field].hex).toBe(fill.toString(16).padStart(2, "0").repeat(32));
  }

  t.signature = new Uint8Array(64).fill(0x55);
  expect(t.signature.length).toBe(SIG_SIZE);
  expect(t.bytes[288]).toBe(0x55); // signature @288
});

test("TickData: header, timelock, indexed digests/fees, signature", () => {
  const td = TickData.alloc();
  td.computorIndex = 11;
  td.tick = 124;
  td.epoch = 3;
  td.timelock = M256i.from(new Uint8Array(32).fill(0x33));
  td.txDigests.set(0, new Uint8Array(32).fill(0xa1));
  td.txDigests.set(TXS_PER_TICK - 1, new Uint8Array(32).fill(0xa2));
  td.contractFees.set(1, 777n);
  td.contractFees.set(CONTRACT_FEES_COUNT - 1, -9n); // last slot, signed
  td.signature = new Uint8Array(64).fill(0x55);

  expect(td.bytes.length).toBe(TICKDATA_SIZE);
  expect(td.computorIndex).toBe(11);
  expect(td.timelock.hex).toBe("33".repeat(32));
  expect(td.txDigests.at(0).hex).toBe("a1".repeat(32));
  expect(td.txDigests.at(TXS_PER_TICK - 1).hex).toBe("a2".repeat(32));
  expect(td.contractFees.at(1)).toBe(777n);
  expect(td.contractFees.at(CONTRACT_FEES_COUNT - 1)).toBe(-9n);
  expect(td.bytes[TickData.SIG_OFFSET]).toBe(0x55);
});

test("Transaction: wrap at offset, variable input + signature, zero-copy", () => {
  const outer = new Uint8Array(10 + Transaction.HEADER_SIZE + 3 + SIG_SIZE);
  const tx = Transaction.wrap(outer, 10);
  tx.sourcePublicKey = new Uint8Array(32).fill(0x01);
  tx.destinationPublicKey = new Uint8Array(32).fill(0x02);
  tx.amount = 9000n;
  tx.tick = 50;
  tx.inputType = 1;
  tx.inputSize = 3;
  tx.input.set([9, 8, 7]);
  tx.signature.set(new Uint8Array(64).fill(0x77));

  const dv = new DataView(outer.buffer);
  expect(dv.getBigInt64(10 + 64, true)).toBe(9000n); // amount @ struct+64
  expect(outer[10 + Transaction.HEADER_SIZE]).toBe(9); // input right after the 80-byte header
  expect(outer[10 + Transaction.HEADER_SIZE + 3]).toBe(0x77); // signature right after input
  expect(tx.input.byteOffset + tx.input.byteLength).toBe(tx.signature.byteOffset); // non-overlap

  const re = Transaction.wrap(outer, 10);
  expect(re.amount).toBe(9000n);
  expect(re.inputType).toBe(1);
  expect(Array.from(re.input)).toEqual([9, 8, 7]);
  expect(re.sourcePublicKey.equals(new Uint8Array(32).fill(0x01))).toBe(true);
});

test("Transaction: empty input puts the signature right after the header", () => {
  const buf = new Uint8Array(Transaction.HEADER_SIZE + 0 + SIG_SIZE);
  const tx = Transaction.wrap(buf);
  tx.inputSize = 0;
  tx.signature.set(new Uint8Array(64).fill(0xee));

  expect(tx.input.length).toBe(0);
  expect(buf[Transaction.HEADER_SIZE]).toBe(0xee); // signature starts at byte 80
  expect(tx.signature[0]).toBe(0xee);
});

test("bridge request/response structs: SIZE == C++ sizeof", () => {
  expect(RequestTickData.SIZE).toBe(4);
  expect(RequestContractFunction.SIZE).toBe(8); // contract.h
  expect(RespondCurrentTickInfo.SIZE).toBe(16); // tick.h
  expect(RespondSystemInfo.SIZE).toBe(128); // system_info.h (#pragma pack(1))
  expect(RespondEntity.SIZE).toBe(EntityRecord.SIZE + 4 + 4 + SPECTRUM_DEPTH * 32); // 840
  expect(RespondOwnedAssets.SIZE).toBe(2 * ASSET_RECORD_SIZE + 4 + 4 + ASSETS_DEPTH * 32); // 872
  expect(RespondPossessedAssets.SIZE).toBe(3 * ASSET_RECORD_SIZE + 4 + 4 + ASSETS_DEPTH * 32); // 920
  expect(RespondTxStatusHeader.SIZE).toBe(12);
});

test("RespondSystemInfo is packed: no alignment padding (u64 at the unaligned @68)", () => {
  // Under natural alignment the i32 solutionThreshold @64 would force 4 bytes of pad before the u64; #pragma
  // pack(1) places it at @68 instead. The derived offsets must reproduce that.
  expect(RespondSystemInfo.OFFSETS).toMatchObject({
    version: 0,
    epoch: 2,
    tick: 4,
    initialTick: 8,
    latestCreatedTick: 12,
    numberOfEntities: 24,
    numberOfTransactions: 28,
    randomMiningSeed: 32,
    solutionThreshold: 64,
    totalSpectrumAmount: 68,
    targetTickVoteSignature: 84,
    computorPacketSignature: 88,
    _reserve4: 120,
  });

  const s = RespondSystemInfo.alloc();
  s.version = -1;
  s.tick = 0x01020304;
  s.totalSpectrumAmount = 123456789n;
  const dv = new DataView(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength);
  expect(dv.getInt16(0, true)).toBe(-1);
  expect(dv.getUint32(4, true)).toBe(0x01020304);
  expect(dv.getBigUint64(68, true)).toBe(123456789n); // unaligned u64 — packed
});

test("RespondEntity embeds a live EntityRecord view + sibling array", () => {
  const r = RespondEntity.alloc();
  r.entity.publicKey = M256i.from(new Uint8Array(32).fill(0xab)); // mutate the embedded record
  r.entity.incomingAmount = 4242n;
  r.tick = 7;
  r.spectrumIndex = -3; // signed
  r.siblings.set(0, new Uint8Array(32).fill(0x11));
  r.siblings.set(SPECTRUM_DEPTH - 1, new Uint8Array(32).fill(0x22));

  // the embed wrote into the parent buffer at the EntityRecord's offsets (publicKey @0, incomingAmount @32)
  const dv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
  expect(r.bytes[0]).toBe(0xab);
  expect(dv.getBigInt64(32, true)).toBe(4242n);
  expect(dv.getUint32(64, true)).toBe(7); // tick after the 64-byte record
  expect(dv.getInt32(68, true)).toBe(-3); // spectrumIndex
  expect(r.siblings.at(0).hex).toBe("11".repeat(32));
  expect(r.siblings.at(SPECTRUM_DEPTH - 1).hex).toBe("22".repeat(32));
});

test("exported constants match the C++ definitions", () => {
  expect(TICKDATA_SIZE).toBe(139376);
  expect(TICKDATA_SIZE).toBe(48 + TXS_PER_TICK * 32 + CONTRACT_FEES_COUNT * 8 + 64);
  expect(ASSET_RECORD_SIZE).toBe(48);
  expect(SPECTRUM_DEPTH).toBe(24);
  expect(ASSETS_DEPTH).toBe(24);
  expect(SIG_SIZE).toBe(64);
  expect(DIGEST_SIZE).toBe(32);
  expect(TXS_PER_TICK).toBe(4096);
  expect(CONTRACT_FEES_COUNT).toBe(1024);
});
