import { test, expect } from "bun:test";
import { arrayFixForLine } from "../src/codefix";

test("rewrites a member array declaration to Array<T, N>", () => {
  expect(arrayFixForLine("  uint64 cells[8];")).toBe("  Array<uint64, 8> cells;");
  expect(arrayFixForLine("id owners[CAP];")).toBe("Array<id, CAP> owners;");
});

test("preserves a trailing comment", () => {
  expect(arrayFixForLine("uint64 a[4]; // count")).toBe("Array<uint64, 4> a; // count");
});

test("bails on shapes it can't safely rewrite", () => {
  expect(arrayFixForLine("uint64 a, b[4];")).toBeNull();   // multi-var
  expect(arrayFixForLine("doSomething(arr[i]);")).toBeNull(); // not a declaration
  expect(arrayFixForLine("Array<uint64, 8> ok;")).toBeNull(); // already fine
});
