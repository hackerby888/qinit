import { test, expect } from "bun:test";
import { encodeInput, decodeOutput, structFieldOffsets, layoutOf, parseLayout } from "../src/abi-fmt";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

test("uint64 round-trip", async () => {
  const b = await encodeInput("42uint64");
  expect(b.length).toBe(8);
  expect(await decodeOutput(b, "uint64")).toBe(42n);
});

test("smaller scalars", async () => {
  expect(await decodeOutput(await encodeInput("7uint8"), "uint8")).toBe(7);
  expect(await decodeOutput(await encodeInput("258uint16"), "uint16")).toBe(258);
  expect(await decodeOutput(await encodeInput("70000uint32"), "uint32")).toBe(70000);
});

test("signed sint64 negative", async () => {
  expect(await decodeOutput(await encodeInput("-5sint64"), "sint64")).toBe(-5n);
  expect(await decodeOutput(await encodeInput("-1sint32"), "sint32")).toBe(-1);
});

test("natural alignment: {uint16, uint32} pads uint32 to offset 4", async () => {
  const b = await encodeInput("5uint16, 7uint32");
  expect(hex(b)).toBe("0500" + "0000" + "07000000"); // val, pad, val
  expect(await decodeOutput(b, "uint16, uint32")).toEqual([5, 7]);
});

test("struct round-trip", async () => {
  const b = await encodeInput("{ 1uint64, 2uint16 }");
  expect(await decodeOutput(b, "{ uint64, uint16 }")).toEqual([1n, 2]);
});

test("array round-trip", async () => {
  const b = await encodeInput("[2; 1uint64, 2uint64]");
  expect(b.length).toBe(16);
  expect(await decodeOutput(b, "[2; uint64]")).toEqual([1n, 2n]);
});

test("nested: array of structs", async () => {
  const b = await encodeInput("[2; { 1uint32, 2uint32 }, { 3uint32, 4uint32 }]");
  expect(await decodeOutput(b, "[2; { uint32, uint32 }]")).toEqual([[1, 2], [3, 4]]);
});

test("id round-trip (32-byte pubkey <-> 60-char identity)", async () => {
  const pub = "1f590d03e613bdded38b4c0820ac44615f91af12435980b3ede3c08c315a2544";
  const id = await decodeOutput(bytes(pub), "id");
  expect(id).toMatch(/^[A-Z]{60}$/);
  expect(hex(await encodeInput(id + "id"))).toBe(pub);
});

test("empty input encodes to zero bytes", async () => {
  expect((await encodeInput("")).length).toBe(0);
});

test("m256i (digest) round-trips as hex, not an identity", async () => {
  const dg = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const b = await encodeInput(dg + "m256i");
  expect(b.length).toBe(32);
  expect(await decodeOutput(b, "m256i")).toBe(dg);
});

test("deep nested: array of structs with an inner array", async () => {
  const b = await encodeInput("[2; { 1uint32, [2; 2uint16, 3uint16] }, { 4uint32, [2; 5uint16, 6uint16] }]");
  expect(await decodeOutput(b, "[2; { uint32, [2; uint16] }]")).toEqual([[1, [2, 3]], [4, [5, 6]]]);
});

test("rejects a malformed id (not 60-char identity nor 64-hex)", async () => {
  await expect(encodeInput("abcid")).rejects.toThrow(/id must be/);
  await expect(encodeInput("notavalidlowercaseidentitynotavalidlowercaseidentitynotavaid")).rejects.toThrow(/id must be/);
});

test("rejects a malformed m256i (not 64 hex)", async () => {
  await expect(encodeInput("zzzm256i")).rejects.toThrow(/m256i must be/);
  await expect(encodeInput("00112233m256i")).rejects.toThrow(/m256i must be/);
});

test("rejects scalar out of range / bad bit", async () => {
  await expect(encodeInput("300uint8")).rejects.toThrow(/out of range/);
  await expect(encodeInput("-1uint8")).rejects.toThrow(/out of range/);
  await expect(encodeInput("70000uint16")).rejects.toThrow(/out of range/);
  await expect(encodeInput("2bit")).rejects.toThrow(/bit must be/);
});

test("bit round-trips 0/1", async () => {
  expect(await decodeOutput(await encodeInput("1bit"), "bit")).toBe(1);
  expect(await decodeOutput(await encodeInput("0bit"), "bit")).toBe(0);
});

// ---- structFieldOffsets / layoutOf / parseLayout: the alignment math decode-log + state-diff rely on ----
test("structFieldOffsets: internal padding (uint8 then uint64 lands at 8)", () => {
  expect(structFieldOffsets("uint8, uint64")).toEqual([{ off: 0, size: 1 }, { off: 8, size: 8 }]);
  expect(structFieldOffsets("uint64, uint8")).toEqual([{ off: 0, size: 8 }, { off: 8, size: 1 }]);
});

test("structFieldOffsets: a nested struct field is aligned + sized as a unit", () => {
  // uint32@0(4), then {uint8,uint64} (align 8, size 16) @8
  expect(structFieldOffsets("uint32, { uint8, uint64 }")).toEqual([{ off: 0, size: 4 }, { off: 8, size: 16 }]);
});

test("layoutOf: TAIL padding included (sizeof != end-of-last-field)", () => {
  expect(layoutOf("{ uint64, uint8 }")).toEqual({ size: 16, align: 8 });  // 9 bytes used -> padded to 16
  expect(layoutOf("uint8")).toEqual({ size: 1, align: 1 });
  expect(layoutOf("m256i")).toEqual({ size: 32, align: 8 });
  expect(layoutOf("[3;uint16]")).toEqual({ size: 6, align: 2 });          // 3 * stride(2)
});

test("layoutOf: HashMap<id,uint64,1024> expansion sizeof = 41232 (matches C++ StateData)", () => {
  // [1024;{id,uint64}]=40960 + [32;uint64] flags=256 + uint64 + uint64 = 41232 (DbgMap marker offset)
  expect(layoutOf("{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }").size).toBe(41232);
});

test("parseLayout: empty -> empty struct; unknown type throws", () => {
  expect(parseLayout("")).toEqual({ kind: "struct", fields: [] });
  expect(() => parseLayout("notatype")).toThrow(/unknown type/);
});

test("decodeOutput on a truncated buffer throws (out-of-bounds read)", async () => {
  await expect(decodeOutput(new Uint8Array(4), "uint64")).rejects.toThrow();  // needs 8 bytes
});
