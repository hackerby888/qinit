// Every template ships a bun:test spec written against its own entries, so a fresh project's first
// `qinit test` exercises the contract it actually has rather than a counter it does not.
import { test, expect } from "bun:test";
import { TEMPLATE_KINDS, templateGtest, templateSource, templateTest } from "../../src/generate/templates";
import { testRuntimeSource } from "../../src/generate/test-scaffold";

for (const kind of TEMPLATE_KINDS) {
    test(`${kind} spec only calls entries the ${kind} template registers`, () => {
        const source = templateSource(kind, "MyToken");
        const registered = new Set([...source.matchAll(/REGISTER_USER_(?:PROCEDURE|FUNCTION)\((\w+),/g)].map((match) => match[1]));
        const spec = templateTest(kind, "MyToken");
        const called = [...spec.matchAll(/\bc\.(\w+)\(/g)].map((match) => match[1]);

        expect(called.length).toBeGreaterThan(0);
        for (const entry of called) {
            expect(registered).toContain(entry);
        }
        expect(spec).toContain("import { MyToken");
        expect(spec).toContain("let c: MyToken;");
        expect(spec).not.toContain("CONTRACT_STATE_TYPE");
        expect((spec.match(/\{/g) ?? []).length).toBe((spec.match(/\}/g) ?? []).length);
    });
}

for (const kind of TEMPLATE_KINDS) {
    test(`${kind} gtest calls every entry the ${kind} template registers and asserts on it`, () => {
        const source = templateSource(kind, "MyToken");
        const registered = [...source.matchAll(/REGISTER_USER_(?:PROCEDURE|FUNCTION)\((\w+),/g)].map((match) => match[1]);
        const gtest = templateGtest(kind, "MyToken");

        for (const entry of registered) {
            expect(gtest).toContain(`MyToken::${entry}_input`);
        }
        expect(gtest.match(/EXPECT_EQ\(/g)?.length ?? 0).toBeGreaterThan(1);
        expect(gtest).toContain("INIT_CONTRACT(MyToken)");
        expect(gtest).toContain("MyToken_CONTRACT_INDEX");
        expect(gtest).not.toContain("CONTRACT_STATE_TYPE");
        expect(gtest).not.toContain("TODO");
        expect((gtest.match(/\{/g) ?? []).length).toBe((gtest.match(/\}/g) ?? []).length);
    });
}

test("testRuntimeSource: the inlined SDK template is present and non-empty", () => {
    expect(testRuntimeSource.startsWith("// @ts-nocheck\n")).toBe(true);
    expect(typeof testRuntimeSource).toBe("string");
    expect(testRuntimeSource.length).toBeGreaterThan(0);
});
