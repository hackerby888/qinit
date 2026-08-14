import { TokenKind } from "../../shared/enums";
import type { Lexer } from "./lexer";
import type { Token } from "./tokens";

export function lexCharLiteral(
    lexer: Lexer,
    start: number,
    startLine: number,
    startCol: number,
): Token {
    let text = "";
    text += lexer.advance(); // opening '
    while (!lexer.eof()) {
        const ch = lexer.peekChar();
        if (ch === "\\") {
            text += lexer.advance(); // backslash
            if (!lexer.eof()) {
                text += lexer.advance(); // escaped char
            }
        } else if (ch === "'") {
            text += lexer.advance(); // closing '
            break;
        } else if (ch === "\n") {
            break; // unterminated
        } else {
            text += lexer.advance();
        }
    }
    return {
        kind: TokenKind.CHAR_LITERAL,
        text,
        span: lexer.makeSpan(start, startLine, startCol),
    };
}

export function lexStringLiteral(
    lexer: Lexer,
    start: number,
    startLine: number,
    startCol: number,
): Token {
    let text = "";
    text += lexer.advance(); // opening "
    while (!lexer.eof()) {
        const ch = lexer.peekChar();
        if (ch === "\\") {
            text += lexer.advance();
            if (!lexer.eof()) {
                text += lexer.advance();
            }
        } else if (ch === '"') {
            text += lexer.advance();
            break;
        } else if (ch === "\n") {
            break; // unterminated
        } else {
            text += lexer.advance();
        }
    }
    return {
        kind: TokenKind.STRING_LITERAL,
        text,
        span: lexer.makeSpan(start, startLine, startCol),
    };
}
