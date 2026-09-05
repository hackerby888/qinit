import { expect, test } from "bun:test";
import { parseAmountQu } from "../../src/commands/deploy-interact/call";

test("--amount accepts only whole decimal qu and keeps every digit", () => {
    expect(parseAmountQu(undefined)).toBe(0n);
    expect(parseAmountQu("")).toBe(0n);
    expect(parseAmountQu("1000")).toBe(1000n);
    expect(parseAmountQu("9223372036854775807")).toBe(2n ** 63n - 1n);
});

test("--amount refuses the spellings Number() would silently reshape", () => {
    for (const text of ["1e3", "0x10", "1.5", "-1", "+5", "1_000", " 12"]) {
        expect(() => parseAmountQu(text)).toThrow(`--amount must be a whole number of qu (got '${text}')`);
    }
    expect(() => parseAmountQu("18446744073709551615")).toThrow("exceeds the signed 64-bit range");
});
