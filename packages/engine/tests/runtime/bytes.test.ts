import { expect, test } from "bun:test";
import {
  bytesEqual,
  concatBytes,
  first32BytesEqual,
  isZeroId,
} from "../../src/bytes";

test("concatBytes preserves part order", () => {
  expect(concatBytes([new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3])])).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

test("identity comparison ignores bytes after the first 32", () => {
  const left = new Uint8Array(33);
  const right = new Uint8Array(33);
  left[32] = 1;
  right[32] = 2;

  expect(first32BytesEqual(left, right)).toBe(true);
  expect(bytesEqual(left, right)).toBe(false);
  expect(isZeroId(left)).toBe(true);

  right[31] = 1;
  expect(first32BytesEqual(left, right)).toBe(false);
});
