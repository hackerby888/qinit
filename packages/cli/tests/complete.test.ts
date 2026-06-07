import { test, expect } from "bun:test";
import { completerFor } from "../src/commands/call-interactive";

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
