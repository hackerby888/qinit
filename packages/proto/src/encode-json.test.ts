import { test, expect } from "bun:test";
import { jsonToInputFmt, encodeInputJson, encodeInput } from "./abi-fmt";

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

test("jsonToInputFmt: nested struct (positional) + fixed array", () => {
  expect(jsonToInputFmt([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1, 2] })).toBe("{ 1uint64, 2uint32 }");
  expect(jsonToInputFmt([{ name: "xs", type: "[3;uint64]" }], { xs: [1, 2, 3] })).toBe("[3; 1uint64, 2uint64, 3uint64]");
});

test("jsonToInputFmt: bool -> bit, big numeric string preserved", () => {
  expect(jsonToInputFmt([{ name: "f", type: "bit" }], { f: true })).toBe("1bit");
  expect(jsonToInputFmt([{ name: "n", type: "uint64" }], { n: "18446744073709551615" })).toBe("18446744073709551615uint64");
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
