import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes } from "../../src/crypto/bytes";

describe("hex byte conversion", () => {
    test("round-trips prefixed and uppercase hex", () => {
        expect(bytesToHex(hexToBytes("0x00AaFF"))).toBe("00aaff");
        expect(hexToBytes("")).toEqual(new Uint8Array(0));
    });

    test("bytes of every length up to 64 survive bytes -> hex -> bytes", () => {
        for (let length = 0; length <= 64; length++) {
            const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length * 11) & 0xff);
            const hex = bytesToHex(bytes);
            expect(hex).toHaveLength(length * 2);
            expect(hexToBytes(hex, length)).toEqual(bytes);
        }
    });

    test("rejects malformed or incorrectly sized input", () => {
        expect(() => hexToBytes("abc")).toThrow(/invalid hex/);
        expect(() => hexToBytes("zz")).toThrow(/invalid hex/);
        expect(() => hexToBytes("0011", 3)).toThrow(/expected 3-byte hex/);
        expect(hexToBytes("0011", 2)).toEqual(new Uint8Array([0, 0x11]));
    });
});
