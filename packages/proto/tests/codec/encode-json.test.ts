import { test, expect } from "bun:test";
import { jsonToInputFmt, encodeInputJson, encodeInput, decodeOutput } from "../../src/abi-fmt";

test("jsonToInputFmt: flat scalars by field name", () => {
  expect(jsonToInputFmt([{ name: "value", type: "uint64" }], { value: 3 })).toBe("3uint64");
  expect(jsonToInputFmt([{ name: "a", type: "uint32" }, { name: "b", type: "sint64" }], { a: 5, b: -7 })).toBe("5uint32, -7sint64");
});

test("jsonToInputFmt: positional array form (order = field order)", () => {
  expect(jsonToInputFmt([{ name: "a", type: "uint8" }, { name: "b", type: "uint16" }], [1, 2])).toBe("1uint8, 2uint16");
});

test("jsonToInputFmt: id field passes the identity through", () => {
  const id = "A".repeat(60);
  expect(jsonToInputFmt([{ name: "dst", type: "id" }], { dst: id })).toBe(`${id}id`);
});

test("encodeInputJson: the 60-A zero identity hint encodes to the zero id", async () => {
  const b = await encodeInputJson([{ name: "dst", type: "id" }], { dst: "A".repeat(60) });
  expect(b).toEqual(new Uint8Array(32));
});

test("jsonToInputFmt: nested struct (positional) + fixed array", () => {
  expect(jsonToInputFmt([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1, 2] })).toBe("{ 1uint64, 2uint32 }");
  expect(jsonToInputFmt([{ name: "xs", type: "[3;uint64]" }], { xs: [1, 2, 3] })).toBe("[3; 1uint64, 2uint64, 3uint64]");
});

test("jsonToInputFmt: bool -> bit, big numeric string preserved", () => {
  expect(jsonToInputFmt([{ name: "f", type: "bit" }], { f: true })).toBe("1bit");
  expect(jsonToInputFmt([{ name: "n", type: "uint64" }], { n: "18446744073709551615" })).toBe("18446744073709551615uint64");
});

test("jsonToInputFmt: uint128 decimal string remains lossless", async () => {
  const max = (1n << 128n) - 1n;
  expect(jsonToInputFmt([{ name: "n", type: "uint128" }], { n: max.toString() })).toBe(`${max}uint128`);
  const b = await encodeInputJson([{ name: "n", type: "uint128" }], { n: max.toString() });
  expect(await decodeOutput(b, "uint128")).toBe(max);
});

test("jsonToInputFmt: missing field + arity mismatch throw", () => {
  expect(() => jsonToInputFmt([{ name: "value", type: "uint64" }], {})).toThrow(/missing input field 'value'/);
  expect(() => jsonToInputFmt([{ name: "xs", type: "[2;uint64]" }], { xs: [1] })).toThrow(/expects 2 elements/);
  expect(() => jsonToInputFmt([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1] })).toThrow(/expects 2 values/);
});

test("encodeInputJson === encodeInput of the equivalent fmt (incl alignment)", async () => {
  const a = await encodeInputJson([{ name: "value", type: "uint64" }], { value: 3 });
  expect([...a]).toEqual([...(await encodeInput("3uint64"))]);
  // {uint8, uint64}: 1B + 7B pad + 8B
  const b = await encodeInputJson([{ name: "s", type: "{ uint8, uint64 }" }], { s: [5, 9] });
  expect([...b]).toEqual([...(await encodeInput("{ 5uint8, 9uint64 }"))]);
  expect(b.length).toBe(16);
});

test("jsonToInputFmt: float value is rejected (BigInt refuses non-integers)", () => {
  expect(() => jsonToInputFmt([{ name: "n", type: "uint64" }], { n: 3.5 })).toThrow();
});

test("jsonToInputFmt: null/undefined value throws", () => {
  expect(() => jsonToInputFmt([{ name: "v", type: "uint64" }], { v: null })).toThrow(/missing value/);
});

test("jsonToInputFmt: extra JSON keys are ignored (only declared fields used)", () => {
  expect(jsonToInputFmt([{ name: "a", type: "uint64" }], { a: 1, unrelated: 99 })).toBe("1uint64");
});

test("encodeInputJson: a bad id surfaces the encode-time validation error", async () => {
  await expect(encodeInputJson([{ name: "dst", type: "id" }], { dst: "tooshort" })).rejects.toThrow(/id must be/);
});

test("encodeInputJson: m256i field round-trips (64-hex -> 32 bytes)", async () => {
  const dg = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const b = await encodeInputJson([{ name: "d", type: "m256i" }], { d: dg });
  expect(b.length).toBe(32);
  expect(await decodeOutput(b, "m256i")).toBe(dg);
});

test("encodeInputJson: deep nested array-of-structs (positional) round-trips", async () => {
  const fields = [{ name: "xs", type: "[2;{ uint32, uint32 }]" }];
  const b = await encodeInputJson(fields, { xs: [[1, 2], [3, 4]] });
  expect(await decodeOutput(b, "[2;{ uint32, uint32 }]")).toEqual([[1, 2], [3, 4]]);
});
