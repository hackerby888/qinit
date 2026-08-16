// Integer literal edges the main lexer suite stops short of — the largest value it asserts is 2^64-1 —
// plus the token cursor, whose peek/reset/getTokens are only ever reached through the parser.
import { describe, expect, test } from "bun:test";
import { Lexer, parseIntLiteral } from "../../src/frontend/lexer";
import { TokenKind } from "../../src/shared/enums";

const VALUES: Record<string, bigint> = {
    "0": 0n,
    "42u": 42n,
    "0xFFull": 255n,
    "0b1010": 10n,
    "0755": 493n,
    "1'000": 1000n,
    "18446744073709551615": 18446744073709551615n,
};

// C++ rejects a prefix with no digits; the compiler reads it as zero instead.
const EMPTY_PREFIXES = ["0x", "0b"];

const MALFORMED = ["09", "08", "0xg", "1e5", "123abc"];

describe("integer literal lexing", () => {
    for (const [literal, expected] of Object.entries(VALUES)) {
        test(`parses ${literal}`, () => {
            expect(parseIntLiteral(literal)).toBe(expected);
        });
    }

    for (const literal of EMPTY_PREFIXES) {
        test(`reads ${literal} with no digits as zero`, () => {
            expect(parseIntLiteral(literal)).toBe(0n);
        });
    }

    for (const literal of MALFORMED) {
        test(`throws on ${literal}`, () => {
            expect(() => parseIntLiteral(literal)).toThrow();
        });
    }

    // Truncation happens later and loudly, at WAT encode, so the lexer hands the value through intact.
    test("a value past uint64 is not clamped", () => {
        expect(parseIntLiteral("18446744073709551616")).toBe(18446744073709551616n);
    });

    test("a hex literal with no valid digits lexes as a bare prefix", () => {
        const tokens = new Lexer("0xZZ").tokenize();

        expect(tokens[0].kind).toBe(TokenKind.INT_LITERAL);
        expect(tokens[0].text).toBe("0x");
        expect(tokens[1].text).toBe("ZZ");
    });

    // parseIntLiteral strips separators, but the scanner never produces a token containing one.
    test("a digit separator splits the literal into separate tokens", () => {
        const tokens = new Lexer("1'0'0").tokenize();

        expect(tokens[0].text).toBe("1");
        expect(tokens[1].kind).toBe(TokenKind.CHAR_LITERAL);
    });
});

describe("token cursor", () => {
    const lex = () => {
        const lexer = new Lexer("a b c");
        lexer.tokenize();
        return lexer;
    };

    test("getTokens answers the tokenized array", () => {
        const lexer = lex();

        expect(lexer.getTokens()).toHaveLength(4);
        expect(lexer.getTokens()[3].kind).toBe(TokenKind.EOF);
    });

    test("peeking past the end yields the eof token", () => {
        expect(lex().peek(99).kind).toBe(TokenKind.EOF);
    });

    test("peek reads ahead without consuming", () => {
        const lexer = lex();

        expect(lexer.peek(1).text).toBe("b");
        expect(lexer.peek().text).toBe("a");
    });

    test("reset rewinds the cursor", () => {
        const lexer = lex();
        lexer.next();
        lexer.next();

        expect(lexer.peek().text).toBe("c");
        lexer.reset();
        expect(lexer.peek().text).toBe("a");
    });
});
