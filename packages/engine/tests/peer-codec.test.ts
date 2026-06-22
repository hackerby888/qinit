// qubic-cli peer codec — the pure wire layer. Asserts the 8-byte header round-trips, the request decoders
// read the cli's struct layouts, and the response encoders place fields at the offsets the cli reads.
import { test, expect } from "bun:test";
import * as codec from "../src/peer-codec";
import { MSG } from "../src/peer-codec";

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

test("header: frame() then readHeader() round-trips size/type/dejavu", () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const f = codec.frame(MSG.RESPOND_ENTITY, payload, 0xdeadbeef);
  const h = codec.readHeader(f)!;

  expect(h.type).toBe(MSG.RESPOND_ENTITY);
  expect(h.size).toBe(codec.HEADER_SIZE + payload.length);
  expect(h.dejavu).toBe(0xdeadbeef);
  expect(f.subarray(codec.HEADER_SIZE)).toEqual(payload);
});

test("readHeader returns null on a short buffer", () => {
  expect(codec.readHeader(new Uint8Array(4))).toBeNull();
});

test("handshake is an ExchangePublicPeers packet (type 0, 16-byte payload)", () => {
  const f = codec.exchangePublicPeers();
  const h = codec.readHeader(f)!;
  expect(h.type).toBe(MSG.EXCHANGE_PUBLIC_PEERS);
  expect(h.size).toBe(codec.HEADER_SIZE + 16);
});

test("decodeContractFunction reads contractIndex/inputType/input", () => {
  const p = new Uint8Array(8 + 3);
  const d = dv(p);
  d.setUint32(0, 28, true);
  d.setUint16(4, 1, true);
  d.setUint16(6, 3, true);
  p.set([9, 8, 7], 8);

  const req = codec.decodeContractFunction(p);
  expect(req.contractIndex).toBe(28);
  expect(req.inputType).toBe(1);
  expect(req.inputSize).toBe(3);
  expect(req.input).toEqual(new Uint8Array([9, 8, 7]));
});

test("encodeRespondEntity places balance fields at the EntityRecord offsets", () => {
  const id = new Uint8Array(32).fill(0x11);
  const enc = codec.encodeRespondEntity(id, {
    incomingAmount: 1000n,
    outgoingAmount: 250n,
    numberOfIncomingTransfers: 3,
    numberOfOutgoingTransfers: 1,
    latestIncomingTransferTick: 7,
    latestOutgoingTransferTick: 5,
  }, 42, 0);

  expect(enc.length).toBe(64 + 4 + 4 + codec.SPECTRUM_DEPTH * 32);
  const d = dv(enc);
  expect(enc.subarray(0, 32)).toEqual(id);
  expect(d.getBigInt64(32, true)).toBe(1000n);
  expect(d.getBigInt64(40, true)).toBe(250n);
  expect(d.getUint32(48, true)).toBe(3);
  expect(d.getUint32(64, true)).toBe(42); // tick
});

test("encodeCurrentTickInfo lays out tick/epoch/alignedVotes", () => {
  const enc = codec.encodeCurrentTickInfo({
    tickDuration: 1000, epoch: 2, tick: 123, numberOfAlignedVotes: 6, numberOfMisalignedVotes: 0, initialTick: 100,
  });
  const d = dv(enc);
  expect(enc.length).toBe(16);
  expect(d.getUint16(0, true)).toBe(1000);
  expect(d.getUint16(2, true)).toBe(2);
  expect(d.getUint32(4, true)).toBe(123);
  expect(d.getUint16(8, true)).toBe(6);
  expect(d.getUint32(12, true)).toBe(100);
});

test("encodeTxStatus sets the moneyFlew bitmask + packs the digests", () => {
  const a = new Uint8Array(32).fill(0xaa);
  const b = new Uint8Array(32).fill(0xbb);
  const enc = codec.encodeTxStatus(50, 48, [a, b], [true, false]);
  const flagBytes = (codec.TXS_PER_TICK + 7) >> 3;
  const d = dv(enc);

  expect(d.getUint32(0, true)).toBe(50); // currentTick
  expect(d.getUint32(4, true)).toBe(48); // tick
  expect(d.getUint32(8, true)).toBe(2); // txCount
  expect(enc[12] & 1).toBe(1); // tx0 moneyFlew
  expect(enc[12] & 2).toBe(0); // tx1 not
  expect(enc.subarray(12 + flagBytes, 12 + flagBytes + 32)).toEqual(a);
});
