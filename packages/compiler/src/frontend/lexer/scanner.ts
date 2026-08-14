import type { Lexer } from "./lexer";
import type { Token } from "./tokens";
import type { Span } from "../../ast";

export function span(lexer: Lexer): Span {
    return { start: lexer.pos, end: lexer.pos, line: lexer.line, column: lexer.column };
}

export function makeSpan(lexer: Lexer, start: number, startLine: number, startCol: number): Span {
    return { start, end: lexer.pos, line: startLine, column: startCol };
}

export function peekChar(lexer: Lexer, offset: number = 0): string {
    const index = lexer.pos + offset;
    if (index >= lexer.src.length) {
        return "\0";
    }
    return lexer.src[index];
}

export function advance(lexer: Lexer): string {
    const ch = lexer.src[lexer.pos];
    lexer.pos++;
    if (ch === "\n") {
        lexer.line++;
        lexer.column = 1;
    } else {
        lexer.column++;
    }
    return ch;
}

export function nextToken(lexer: Lexer): Token | null {
    // Skip whitespace and comments
    while (!lexer.eof()) {
        const ch = lexer.peekChar();
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            lexer.advance();
            continue;
        }
        if (ch === "/") {
            const next = lexer.peekChar(1);
            if (next === "/") {
                lexer.skipLineComment();
                continue;
            }
            if (next === "*") {
                lexer.skipBlockComment();
                continue;
            }
        }
        break;
    }
    if (lexer.eof()) {
        return null;
    }
    const start = lexer.pos;
    const startLine = lexer.line;
    const startCol = lexer.column;
    const ch = lexer.peekChar();
    // Identifiers and keywords
    if (lexer.isIdStart(ch)) {
        return lexer.lexIdOrKeyword(start, startLine, startCol);
    }
    // Numbers
    if (ch >= "0" && ch <= "9") {
        return lexer.lexNumber(start, startLine, startCol);
    }
    // Character literal
    if (ch === "'") {
        return lexer.lexCharLiteral(start, startLine, startCol);
    }
    // String literal
    if (ch === '"') {
        return lexer.lexStringLiteral(start, startLine, startCol);
    }
    // Operators and punctuators
    return lexer.lexOperator(start, startLine, startCol);
}

export function advanceN(lexer: Lexer, count: number): string {
    let text = "";
    for (let index = 0; index < count && !lexer.eof(); index++) {
        text += lexer.advance();
    }
    return text;
}
