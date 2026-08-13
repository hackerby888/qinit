import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseCallees } from "../../src/contracts/callees";

test("parseCallees parses repeated declarations", () => {
    expect(parseCallees(["Counter=contracts/Counter.h", "Oracle=Oracle.h@29"])).toEqual({
        Counter: { header: resolve("contracts/Counter.h") },
        Oracle: { header: resolve("Oracle.h"), index: 29 },
    });
});

test("parseCallees rejects malformed and duplicate declarations", () => {
    expect(() => parseCallees(["Counter.h@28"])).toThrow("expected Name=header[@index]");
    expect(() => parseCallees(["Counter=a.h@28", "Counter=b.h@29"])).toThrow(
        "duplicate --callee name 'Counter'",
    );
    expect(() => parseCallees(["Counter=a.h@4294967296"])).toThrow("unsigned 32-bit integer");
});
