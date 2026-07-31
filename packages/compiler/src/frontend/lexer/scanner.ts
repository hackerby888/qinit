import type { LexerInternals } from "./lexer-context";
import type { Token } from "./tokens";
import type { Span } from "../../ast";

export function span(context: LexerInternals): Span {
    return { start: context.pos, end: context.pos, line: context.line, column: context.column };
}

export function makeSpan(context: LexerInternals, start: number, startLine: number, startCol: number): Span {
    return { start, end: context.pos, line: startLine, column: startCol };
}

export function peekChar(context: LexerInternals, offset: number = 0): string {
    const index = context.pos + offset;
    if (index >= context.src.length) {
        return "\0";
    }
    return context.src[index];
}

export function advance(context: LexerInternals): string {
    const ch = context.src[context.pos];
    context.pos++;
    if (ch === "\n") {
        context.line++;
        context.column = 1;
    }
    else {
        context.column++;
    }
    return ch;
}

export function nextToken(context: LexerInternals): Token | null {
    // Skip whitespace and comments
    while (!context.eof()) {
        const ch = context.peekChar();
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            context.advance();
            continue;
        }
        if (ch === "/") {
            const next = context.peekChar(1);
            if (next === "/") {
                context.skipLineComment();
                continue;
            }
            if (next === "*") {
                context.skipBlockComment();
                continue;
            }
        }
        break;
    }
    if (context.eof()) {
        return null;
    }
    const start = context.pos;
    const startLine = context.line;
    const startCol = context.column;
    const ch = context.peekChar();
    // Identifiers and keywords
    if (context.isIdStart(ch)) {
        return context.lexIdOrKeyword(start, startLine, startCol);
    }
    // Numbers
    if (ch >= "0" && ch <= "9") {
        return context.lexNumber(start, startLine, startCol);
    }
    // Character literal
    if (ch === "'") {
        return context.lexCharLiteral(start, startLine, startCol);
    }
    // String literal
    if (ch === '"') {
        return context.lexStringLiteral(start, startLine, startCol);
    }
    // Operators and punctuators
    return context.lexOperator(start, startLine, startCol);
}

export function advanceN(context: LexerInternals, count: number): string {
    let text = "";
    for (let index = 0; index < count && !context.eof(); index++) {
        text += context.advance();
    }
    return text;
}
