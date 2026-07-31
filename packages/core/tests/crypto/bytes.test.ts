import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes } from "../../src/bytes";

describe("hex byte conversion", () => {
  test("round-trips prefixed and uppercase hex", () => {
    expect(bytesToHex(hexToBytes("0x00AaFF"))).toBe("00aaff");
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });

  test("rejects malformed or incorrectly sized input", () => {
    expect(() => hexToBytes("abc")).toThrow(/invalid hex/);
    expect(() => hexToBytes("zz")).toThrow(/invalid hex/);
    expect(() => hexToBytes("0011", 3)).toThrow(/expected 3-byte hex/);
    expect(hexToBytes("0011", 2)).toEqual(new Uint8Array([0, 0x11]));
  });
});
