import type { LexerInternals } from "./lexer-context";
import type { Token } from "./tokens";

export function lexNumber(context: LexerInternals, start: number, startLine: number, startCol: number): Token {
    let text = "";
    let isFloat = false;
    // Check for hex (0x / 0X) or binary (0b / 0B)
    if (context.peekChar() === "0") {
        text += context.advance();
        const next = context.peekChar().toLowerCase();
        if (next === "x") {
            text += context.advance();
            while (!context.eof() && (context.isHexDigit(context.peekChar()) || context.peekChar() === "'")) {
                text += context.advance();
            }
            text += context.peekSuffix();
            return { kind: "int_literal", text, span: context.makeSpan(start, startLine, startCol) };
        }
        if (next === "b") {
            text += context.advance();
            while (!context.eof() &&
                (context.peekChar() === "0" || context.peekChar() === "1" || context.peekChar() === "'")) {
                text += context.advance();
            }
            text += context.peekSuffix();
            return { kind: "int_literal", text, span: context.makeSpan(start, startLine, startCol) };
        }
    }
    // Decimal number (might be float)
    while (!context.eof()) {
        const ch = context.peekChar();
        if (ch >= "0" && ch <= "9") {
            text += context.advance();
        }
        else if (ch === "." && context.peekChar(1) >= "0" && context.peekChar(1) <= "9") {
            isFloat = true;
            text += context.advance(); // .
        }
        else {
            break;
        }
    }
    // Integer suffix: u, l, ll, ul, ull, lu, llu
    if (!isFloat && !context.eof()) {
        const suf = context.peekSuffix();
        if (suf) {
            text += suf;
        }
    }
    if (isFloat) {
        return { kind: "float_literal", text, span: context.makeSpan(start, startLine, startCol) };
    }
    return { kind: "int_literal", text, span: context.makeSpan(start, startLine, startCol) };
}

export function peekSuffix(context: LexerInternals): string {
    const rest = context.src.slice(context.pos, context.pos + 4).toLowerCase();
    // ull, llu
    if (rest.startsWith("ull")) {
        return context.advanceN(3);
    }
    if (rest.startsWith("llu")) {
        return context.advanceN(3);
    }
    // ul, lu, ll
    if (rest.startsWith("ul")) {
        return context.advanceN(2);
    }
    if (rest.startsWith("lu")) {
        return context.advanceN(2);
    }
    if (rest.startsWith("ll")) {
        return context.advanceN(2);
    }
    // u, l
    if (rest[0] === "u" || rest[0] === "l") {
        return context.advanceN(1);
    }
    return "";
}

export function isHexDigit(context: LexerInternals, ch: string): boolean {
    return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}
