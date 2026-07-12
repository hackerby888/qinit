import { test, expect } from "bun:test";
import { completerFor, zeroSample, tmplOf } from "../../src/commands/call-interactive";

const E = (o: any) => ({ kind: "fn", inputType: 1, inputSize: 0, outputSize: 0, ...o });

test("zeroSample: schema-matched all-zero sample from e.in, else from inFields", () => {
  expect(zeroSample(E({ in: "uint64" }))).toBe("0uint64");
  expect(zeroSample(E({ in: "[64; uint64], id" }))).toBe(`[64; 0uint64 ×64], ${"0".repeat(64)}id`);
  expect(zeroSample(E({ inFields: [{ name: "a", type: "uint32" }, { name: "b", type: "id" }] }))).toBe(`0uint32, ${"0".repeat(64)}id`);
});

test("zeroSample: null for no-input and a sample for uint128", () => {
  expect(zeroSample(E({ in: "" }))).toBe(null);
  expect(zeroSample(E({}))).toBe(null);            // no in, no inFields
  expect(zeroSample(E({ in: "uint128" }))).toBe("0uint128");
});

test("tmplOf: <name>type per field; undefined when no fields", () => {
  expect(tmplOf([{ name: "reveal", type: "[64; uint64]" }, { name: "commit", type: "id" }])).toBe("<reveal>[64; uint64], <commit>id");
  expect(tmplOf([])).toBeUndefined();
  expect(tmplOf(undefined)).toBeUndefined();
});

test("completerFor: prefers the field's expected type", () => {
  const c = completerFor([{ name: "who", type: "id" }, { name: "amt", type: "uint32" }]);
  expect(c("<id>id, 1u")).toBe("<id>id, 1uint32");   // 2nd field is uint32 -> not the generic uint64
  expect(c("1u")).toBe("1uint64");                    // 1st field is id; "u" doesn't match id -> generic uint64
});

test("completerFor: generic fallback when no schema / non-scalar field", () => {
  const c = completerFor(undefined);
  expect(c("1u")).toBe("1uint64");                    // generic first-match
  expect(c("5sint")).toBe("5sint64");
  expect(c("9")).toBe(null);                          // no type fragment
});

test("completerFor: expected only wins when it matches the fragment", () => {
  const c = completerFor([{ name: "n", type: "uint32" }]);
  expect(c("1uint6")).toBe("1uint64");                // uint32 doesn't start with uint6 -> uint64
});
