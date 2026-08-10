// A trace names what it invoked from a kind and a number, and both the list and the detail header read it
// off this one helper — so the numbering rules it encodes are worth pinning.
import { expect, test } from "bun:test";
import type { ContractIdl } from "@qinit/proto/contract-idl";
import { entryLabel } from "../../src/trace/entry-label";

const idl = {
  functions: [{ name: "GetCount", inputType: 0 }],
  procedures: [{ name: "Increase", inputType: 1 }],
} as unknown as ContractIdl;

test("user entries are named from the IDL", () => {
  expect(entryLabel(0, 0, idl)).toBe("fn#0 (GetCount)");
  expect(entryLabel(1, 1, idl)).toBe("proc#1 (Increase)");
});

test("an already-resolved name is used as it stands", () => {
  expect(entryLabel(1, 1, "Increase")).toBe("proc#1 (Increase)");
});

test("system procedures are named without an IDL", () => {
  expect(entryLabel(2, 0)).toBe("sys#0 (INITIALIZE)");
  expect(entryLabel(2, 1)).toBe("sys#1 (BEGIN_EPOCH)");
});

// Migrate records entry 0, which would otherwise read as the system procedure of that id.
test("migrate is not mistaken for a system procedure", () => {
  expect(entryLabel(3, 0)).toBe("migrate");
});

test("an unresolved entry keeps its bare number", () => {
  expect(entryLabel(1, 9, idl)).toBe("proc#9");
  expect(entryLabel(0, 0)).toBe("fn#0");
  expect(entryLabel(2, 250)).toBe("sys#250");
});
