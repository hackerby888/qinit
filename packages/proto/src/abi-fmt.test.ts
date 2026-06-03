import { test, expect } from "bun:test";
import { encodeInput, decodeOutput } from "./abi-fmt";

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
