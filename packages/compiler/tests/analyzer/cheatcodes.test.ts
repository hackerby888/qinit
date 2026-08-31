// Stripping has to be provably harmless: the scanner rules exist only to guarantee that blanking a
// cheat call can never change what the contract does.
import { expect, test } from "bun:test";
import { analyzeCheatcodes, stripCheatcodes } from "../../src/analyzer/cheatcodes";

const codes = (source: string): string[] => analyzeCheatcodes(source).map((diagnostic) => diagnostic.code);

test("a cheat is blanked in place, leaving the line count and the semicolon alone", () => {
    const source = `PUBLIC_PROCEDURE(P) {\n    CC_PRINT("x", locals.n);\n    state.mut().n += 1;\n}`;
    const stripped = stripCheatcodes(source);

    expect(stripped.split("\n").length).toBe(source.split("\n").length);
    expect(stripped).not.toMatch(/CC_/);
    expect(stripped).toContain("state.mut().n += 1;");
    expect(stripped.split("\n")[1].trim()).toBe(";");
});

test("an unbraced else still finds its statement after stripping", () => {
    const stripped = stripCheatcodes(`PUBLIC_PROCEDURE(P) { if (x) CC_PRINT("a"); else f(); }`);

    expect(stripped).toMatch(/if \(x\)\s+; else f\(\);/);
});

test("stripping is idempotent", () => {
    const source = `PUBLIC_PROCEDURE(P) { CC_PRINT("x"); CC_ASSERT(y > 0); }`;
    const once = stripCheatcodes(source);

    expect(stripCheatcodes(once)).toBe(once);
});

test("the CC_ prefix is reserved, so a typo is caught rather than silently kept", () => {
    expect(codes(`PUBLIC_PROCEDURE(P) { CC_PRIN(1); }`)).toEqual(["cheat/reserved-prefix"]);
});

test("a cheat must stand alone as a statement, or blanking it would change an expression", () => {
    expect(codes(`PUBLIC_PROCEDURE(P) { x = CC_PRINT(1); }`)).toContain("cheat/statement-only");
    expect(codes(`PUBLIC_PROCEDURE(P) { CC_PRINT(1) }`)).toContain("cheat/statement-only");
});

test("arguments may not have side effects, because they disappear in production", () => {
    expect(codes(`PUBLIC_PROCEDURE(P) { CC_PRINT(helper(1)); }`)).toContain("cheat/no-side-effects");
    expect(codes(`PUBLIC_PROCEDURE(P) { CC_PRINT(state.mut().n = 1); }`)).toContain("cheat/no-side-effects");
});

test("reads through qpi and state are what a print is built from, so they stay legal", () => {
    expect(codes(`PUBLIC_PROCEDURE(P) { CC_PRINT("t", qpi.tick()); }`)).toEqual([]);
    expect(codes(`PUBLIC_PROCEDURE(P) { CC_PRINT(state.get().n); }`)).toEqual([]);
});

test("a mutator cannot run inside a function, but a print can", () => {
    expect(codes(`PUBLIC_FUNCTION(F) { CC_DEAL(who, 1); }`)).toEqual(["cheat/mutator-in-function"]);
    expect(codes(`PUBLIC_FUNCTION(F) { CC_PRINT("x"); }`)).toEqual([]);
});

test("CC_ inside a comment is not a call, so the lexer decides rather than a regex", () => {
    const source = `PUBLIC_PROCEDURE(P) {\n    // CC_PRINT(1);\n    state.mut().n += 1;\n}`;

    expect(codes(source)).toEqual([]);
    expect(stripCheatcodes(source)).toBe(source);
});
