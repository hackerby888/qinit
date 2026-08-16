// Covers the directives that run on every compile but had no test — #include and #pragma once come from
// qpi.h itself — plus the #if expression evaluator, which used to drop hex, octal and ternary syntax.
import { describe, expect, test } from "bun:test";
import { Preprocessor } from "../../src/frontend/preprocessor";

const pp = (source: string): string =>
    new Preprocessor().preprocess({
        source,
        qpiHeader: "",
        contractName: "T",
        contractIndex: 0,
    });

const lines = (source: string): string[] =>
    pp(source)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

// Reduces an #if expression to the branch it selects.
const IF = (expression: string): string => `#if ${expression}\nT\n#else\nF\n#endif`;

describe("#include, #pragma and #error", () => {
    test("a quoted include is dropped", () => {
        expect(lines(`#include "foo.h"\nX`)).toEqual(["X"]);
    });

    test("an angled include is dropped", () => {
        expect(lines(`#include <bar>\nX`)).toEqual(["X"]);
    });

    test("an include with no filename does not stall the scanner", () => {
        expect(lines(`#include\nX`)).toEqual(["X"]);
    });

    test("an unterminated include filename stops at the newline", () => {
        expect(lines(`#include "foo.h\nX`)).toEqual(["X"]);
    });

    test("pragma once is dropped", () => {
        expect(lines(`#pragma once\nX`)).toEqual(["X"]);
    });

    test("an unknown pragma is preserved as a comment", () => {
        expect(lines(`#pragma pack(1)\nX`)).toEqual(["// #pragma pack (1)", "X"]);
    });

    test("an include inside an inactive branch is skipped", () => {
        expect(lines(`#ifdef NOPE\n#include "x.h"\n#endif\nX`)).toEqual(["X"]);
    });

    test("a pragma inside an inactive branch emits nothing", () => {
        expect(lines(`#if 0\n#pragma pack(1)\n#endif\nX`)).toEqual(["X"]);
    });

    // The Preprocessor has no diagnostic channel, so an active #error cannot fail the build today.
    test("an active error directive is a no-op", () => {
        expect(lines(`#if 1\nA\n#error boom\nB\n#endif`)).toEqual(["A", "B"]);
    });

    test("a warning directive is dropped", () => {
        expect(lines(`#if 1\nA\n#warning careful\nB\n#endif`)).toEqual(["A", "B"]);
    });

    test("an unknown directive is skipped", () => {
        expect(lines(`#if 1\nA\n#nonsense zzz\nB\n#endif`)).toEqual(["A", "B"]);
    });
});

const TRUE_CONDITIONS = [
    "0x10",
    "0xFF == 255",
    "010 == 8",
    "8 >> 2 == 2",
    "(1 | 2) == 3",
    "(3 ^ 1) == 2",
    "(6 & 4) == 4",
    "-3 + 4",
    "!0 && 1",
    "2 <= 2 && 3 >= 3",
    "1 != 2",
    "1 < 2",
    "3 > 2",
    "7 % 4 == 3",
    "6 / 2 == 3",
    "2 * 3 == 6",
    "1 << 3 == 8",
    "0 || 1",
    "true && !false",
    "1 ? 1 : 0",
    "0 ? 0 : 1",
];

const FALSE_CONDITIONS = ["1 ? 0 : 1", "NOPE", "1 / 0", "5 % 0", "", "0x0"];

describe("#if arithmetic", () => {
    for (const condition of TRUE_CONDITIONS) {
        test(`selects the then branch for ${condition || "an empty condition"}`, () => {
            expect(lines(IF(condition))).toEqual(["T"]);
        });
    }

    for (const condition of FALSE_CONDITIONS) {
        test(`selects the else branch for ${condition || "an empty condition"}`, () => {
            expect(lines(IF(condition))).toEqual(["F"]);
        });
    }

    test("a hex-valued macro is truthy", () => {
        expect(lines(`#define K 0x1\n${IF("K")}`)).toEqual(["T"]);
    });

    test("a decimal macro keeps its value", () => {
        expect(lines(`#define K 7\n${IF("K == 7")}`)).toEqual(["T"]);
    });

    test("a non-numeric macro body evaluates as zero", () => {
        expect(lines(`#define K some_text\n${IF("K")}`)).toEqual(["F"]);
    });

    test("defined without parentheses is supported", () => {
        expect(lines(`#define FOO 1\n${IF("defined FOO")}`)).toEqual(["T"]);
    });

    test("an unterminated parenthesis does not throw", () => {
        expect(lines(IF("(1"))).toEqual(["T"]);
    });

    test("a nested ternary associates to the right", () => {
        expect(lines(IF("1 ? 1 ? 5 : 0 : 9"))).toEqual(["T"]);
    });

    test("an elif chain picks the first true branch", () => {
        expect(lines(`#if 0\nA\n#elif 1\nB\n#else\nC\n#endif`)).toEqual(["B"]);
    });
});
