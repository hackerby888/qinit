import { TokenKind } from "../../enums";
import type { LexerInternals } from "./lexer-context";
import type { Token } from "./tokens";

export function lexCharLiteral(context: LexerInternals, start: number, startLine: number, startCol: number): Token {
    let text = "";
    text += context.advance(); // opening '
    while (!context.eof()) {
        const ch = context.peekChar();
        if (ch === "\\") {
            text += context.advance(); // backslash
            if (!context.eof()) {
                text += context.advance(); // escaped char
            }
        }
        else if (ch === "'") {
            text += context.advance(); // closing '
            break;
        }
        else if (ch === "\n") {
            break; // unterminated
        }
        else {
            text += context.advance();
        }
    }
    return { kind: TokenKind.CHAR_LITERAL, text, span: context.makeSpan(start, startLine, startCol) };
}

export function lexStringLiteral(context: LexerInternals, start: number, startLine: number, startCol: number): Token {
    let text = "";
    text += context.advance(); // opening "
    while (!context.eof()) {
        const ch = context.peekChar();
        if (ch === "\\") {
            text += context.advance();
            if (!context.eof()) {
                text += context.advance();
            }
        }
        else if (ch === '"') {
            text += context.advance();
            break;
        }
        else if (ch === "\n") {
            break; // unterminated
        }
        else {
            text += context.advance();
        }
    }
    return { kind: TokenKind.STRING_LITERAL, text, span: context.makeSpan(start, startLine, startCol) };
}
