import { TokenKind } from "../../shared/enums";
import type { Lexer } from "./lexer";
import type { Token } from "./tokens";

export function lexNumber(lexer: Lexer, start: number, startLine: number, startCol: number): Token {
    let text = "";
    let isFloat = false;
    // Check for hex (0x / 0X) or binary (0b / 0B)
    if (lexer.peekChar() === "0") {
        text += lexer.advance();
        const next = lexer.peekChar().toLowerCase();
        if (next === "x") {
            text += lexer.advance();
            while (!lexer.eof() && (lexer.isHexDigit(lexer.peekChar()) || lexer.peekChar() === "'")) {
                text += lexer.advance();
            }
            text += lexer.peekSuffix();
            return {
                kind: TokenKind.INT_LITERAL,
                text,
                span: lexer.makeSpan(start, startLine, startCol),
            };
        }
        if (next === "b") {
            text += lexer.advance();
            while (!lexer.eof() && (lexer.peekChar() === "0" || lexer.peekChar() === "1" || lexer.peekChar() === "'")) {
                text += lexer.advance();
            }
            text += lexer.peekSuffix();
            return {
                kind: TokenKind.INT_LITERAL,
                text,
                span: lexer.makeSpan(start, startLine, startCol),
            };
        }
    }
    // Decimal number (might be float)
    while (!lexer.eof()) {
        const ch = lexer.peekChar();
        if (ch >= "0" && ch <= "9") {
            text += lexer.advance();
        } else if (ch === "." && lexer.peekChar(1) >= "0" && lexer.peekChar(1) <= "9") {
            isFloat = true;
            text += lexer.advance(); // .
        } else {
            break;
        }
    }
    // Integer suffix: u, l, ll, ul, ull, lu, llu
    if (!isFloat && !lexer.eof()) {
        const suf = lexer.peekSuffix();
        if (suf) {
            text += suf;
        }
    }
    if (isFloat) {
        return {
            kind: TokenKind.FLOAT_LITERAL,
            text,
            span: lexer.makeSpan(start, startLine, startCol),
        };
    }
    return {
        kind: TokenKind.INT_LITERAL,
        text,
        span: lexer.makeSpan(start, startLine, startCol),
    };
}

export function peekSuffix(lexer: Lexer): string {
    const rest = lexer.src.slice(lexer.pos, lexer.pos + 4).toLowerCase();
    // ull, llu
    if (rest.startsWith("ull")) {
        return lexer.advanceN(3);
    }
    if (rest.startsWith("llu")) {
        return lexer.advanceN(3);
    }
    // ul, lu, ll
    if (rest.startsWith("ul")) {
        return lexer.advanceN(2);
    }
    if (rest.startsWith("lu")) {
        return lexer.advanceN(2);
    }
    if (rest.startsWith("ll")) {
        return lexer.advanceN(2);
    }
    // u, l
    if (rest[0] === "u" || rest[0] === "l") {
        return lexer.advanceN(1);
    }
    return "";
}

export function isHexDigit(ch: string): boolean {
    return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}
