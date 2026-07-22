// Verifies QPI DateAndTime packing, including full-year bits and zero microseconds.
import { test, expect } from "bun:test";
import { packDateAndTime, dateFields } from "../../src/runtime";

test("packDateAndTime lays the fields at the qpi.h DateAndTime bit offsets", () => {
  const ms = Date.UTC(2024, 2, 15, 13, 45, 30, 123); // 2024-03-15 13:45:30.123 UTC
  const v = packDateAndTime(ms);

  expect(Number(v >> 46n)).toBe(2024); // full year
  expect(Number((v >> 42n) & 0xfn)).toBe(3); // month
  expect(Number((v >> 37n) & 0x1fn)).toBe(15); // day
  expect(Number((v >> 32n) & 0x1fn)).toBe(13); // hour
  expect(Number((v >> 26n) & 0x3fn)).toBe(45); // minute
  expect(Number((v >> 20n) & 0x3fn)).toBe(30); // second
  expect(Number((v >> 10n) & 0x3ffn)).toBe(123); // millisecond
  expect(Number(v & 0x3ffn)).toBe(0); // microsecond not modeled
});

test("packDateAndTime stores the full year while the accessors stay 2-digit", () => {
  const ms = Date.UTC(2031, 11, 1, 0, 0, 0, 0);
  expect(dateFields(ms).year).toBe(31); // the qubic 2-digit accessor form
  expect(Number(packDateAndTime(ms) >> 46n)).toBe(2031); // now() packs the full year
});
