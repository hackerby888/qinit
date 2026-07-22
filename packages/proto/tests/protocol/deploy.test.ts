import { test, expect } from "bun:test";
import {
  LITE_TX,
  CHUNK_DATA_MAX,
  encodeUploadBegin,
  encodeUploadChunk,
  encodeDeploy,
  chunkSo,
  newSessionId,
} from "../../src/deploy";
import { contractAddress } from "../../src/call";
import { WASM_ABI_VERSION } from "@qinit/core";

const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const u32le = (b: Uint8Array, o: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const u64le = (b: Uint8Array, o: number) =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);
const HASH32 = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("LITE_TX inputTypes + CHUNK_DATA_MAX are the wire constants", () => {
  expect(LITE_TX).toEqual({ UPLOAD_BEGIN: 240, UPLOAD_CHUNK: 241, DEPLOY: 242 });
  expect(CHUNK_DATA_MAX).toBe(1008);
});

test("encodeUploadBegin: 48 bytes, LE fields, hash at offset 16", () => {
  const b = encodeUploadBegin({
    sessionId: 0x1122334455667788n,
    totalSize: 5000,
    chunkCount: 5,
    finalHashHex: HASH32,
  });
  expect(b.length).toBe(48);
  expect(u64le(b, 0)).toBe(0x1122334455667788n);
  expect(u32le(b, 8)).toBe(5000);
  expect(u32le(b, 12)).toBe(5);
  expect(hx(b.slice(16))).toBe(HASH32);
});

test("encodeUploadBegin: rejects a wrong-length finalHash", () => {
  expect(() =>
    encodeUploadBegin({ sessionId: 1n, totalSize: 1, chunkCount: 1, finalHashHex: "abcd" }),
  ).toThrow(/32-byte hex/);
});

test("encodeUploadChunk: 14B header + data; len field; empty data", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const b = encodeUploadChunk({ sessionId: 7n, seq: 2, bytes: data });
  expect(b.length).toBe(18);
  expect(u64le(b, 0)).toBe(7n);
  expect(u32le(b, 8)).toBe(2);
  expect(new DataView(b.buffer).getUint16(12, true)).toBe(4);
  expect(hx(b.slice(14))).toBe("01020304");
  expect(encodeUploadChunk({ sessionId: 1n, seq: 0, bytes: new Uint8Array(0) }).length).toBe(14);
});

test("encodeUploadChunk: exactly CHUNK_DATA_MAX ok, one more throws", () => {
  expect(
    encodeUploadChunk({ sessionId: 1n, seq: 0, bytes: new Uint8Array(CHUNK_DATA_MAX) }).length,
  ).toBe(14 + CHUNK_DATA_MAX);
  expect(() =>
    encodeUploadChunk({ sessionId: 1n, seq: 0, bytes: new Uint8Array(CHUNK_DATA_MAX + 1) }),
  ).toThrow(/chunk too large/);
});

test("encodeDeploy: 84 bytes, offsets, version defaults", () => {
  const b = encodeDeploy({ sessionId: 9n, targetSlot: 28, finalHashHex: HASH32 });
  expect(b.length).toBe(84);
  expect(u64le(b, 0)).toBe(9n);
  expect(u32le(b, 8)).toBe(28);
  expect(hx(b.slice(12, 44))).toBe(HASH32);
  expect(u32le(b, 44)).toBe(WASM_ABI_VERSION);
  expect(u32le(b, 48)).toBe(0); // stateLayoutVersion default
});

test("encodeDeploy: name written at 52, truncated to 31, high bit stripped", () => {
  const b = encodeDeploy({ sessionId: 1n, targetSlot: 0, finalHashHex: HASH32, name: "Counter" });
  expect(String.fromCharCode(...b.slice(52, 59))).toBe("Counter");
  expect(b[59]).toBe(0); // null after name
  const long = encodeDeploy({
    sessionId: 1n,
    targetSlot: 0,
    finalHashHex: HASH32,
    name: "x".repeat(40),
  });
  expect(long.slice(52).filter((c) => c === 120).length).toBe(31); // 'x' = 120, capped at 31
  const hi = encodeDeploy({ sessionId: 1n, targetSlot: 0, finalHashHex: HASH32, name: "é" }); // 0xe9 -> &0x7f
  expect(hi[52]).toBe(0xe9 & 0x7f);
});

test("chunkSo: empty, partial, exact-multiple boundaries; concat === original", () => {
  expect(chunkSo(new Uint8Array(0))).toEqual([]);
  expect(chunkSo(new Uint8Array(10), 4).map((c) => c.length)).toEqual([4, 4, 2]); // partial last
  expect(chunkSo(new Uint8Array(8), 4).map((c) => c.length)).toEqual([4, 4]); // exact multiple
  expect(chunkSo(new Uint8Array(3), 4).map((c) => c.length)).toEqual([3]); // < size
  const src = new Uint8Array(2050);
  src.forEach((_, i) => (src[i] = i & 0xff));
  const chunks = chunkSo(src);
  expect(chunks.length).toBe(3); // 1008,1008,34
  expect(hx(new Uint8Array(chunks.flatMap((c) => [...c])))).toBe(hx(src));
});

test("newSessionId: a uint64-range bigint", () => {
  const s = newSessionId();
  expect(typeof s).toBe("bigint");
  expect(s >= 0n && s < 1n << 64n).toBe(true);
});

test("contractAddress: id(index,0,0,0) little-endian, 32 bytes", () => {
  const a = contractAddress(28);
  expect(a.length).toBe(32);
  expect(a[0]).toBe(0x1c);
  expect(hx(a.slice(1))).toBe("00".repeat(31));
  expect(hx(contractAddress(0))).toBe("00".repeat(32));
});
