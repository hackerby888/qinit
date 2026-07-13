import { test, expect } from "bun:test";
import { parseVerifyJson, verifyErrors } from "../../src/verify-parse";

test("parseVerifyJson reads the last JSON line", () => {
  expect(parseVerifyJson('{"ok":true,"available":false,"errors":[]}')).toEqual({
    ok: true,
    available: false,
    errors: [],
  });
  expect(parseVerifyJson('noise line\n{"ok":false,"available":true,"errors":["x"]}\n')).toEqual({
    ok: false,
    available: true,
    errors: ["x"],
  });
  expect(parseVerifyJson("not json")).toBeNull();
  expect(parseVerifyJson("")).toBeNull();
});

test("verifyErrors surfaces only real violations", () => {
  expect(verifyErrors({ ok: true, available: true, errors: [] })).toEqual([]); // clean
  expect(verifyErrors({ ok: false, available: false, errors: ["x"] })).toEqual([]); // tool absent -> skip
  expect(verifyErrors({ ok: false, available: true, errors: ["a", "b"] })).toEqual(["a", "b"]);
  expect(verifyErrors(null)).toEqual([]);
});
