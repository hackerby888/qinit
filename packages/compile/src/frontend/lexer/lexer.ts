import type { Span } from "../../ast";
import type { Token } from "./tokens";
import * as lexerPart0 from "./token-stream";
import * as lexerPart1 from "./scanner";
import * as lexerPart2 from "./identifier-lexer";
import * as lexerPart3 from "./number-lexer";
import * as lexerPart4 from "./literal-lexer";
import * as lexerPart5 from "./operator-lexer";
import * as lexerPart6 from "./comment-lexer";
import * as lexerPart7 from "./type-keyword-collapse";

// ---- Lexer ----
export class Lexer {
    src: string;
    pos: number = 0;
    line: number = 1;
    column: number = 1;
    tokens: Token[] = [];
    index: number = 0;
    constructor(src: string) {
        this.src = src;
    }
    // Tokenize the entire source and return an array. Also collapses multi-word type keywords.
    tokenize(): Token[] {
        return lexerPart0.tokenize(this);
    }
    // Get the token stream (for parser)
    getTokens(): Token[] {
        return lexerPart0.getTokens(this);
    }
    // Reset for streaming parse
    reset(): void {
        return lexerPart0.reset(this);
    }
    // Streaming interface
    peek(offset: number = 0): Token {
        return lexerPart0.peek(this, offset);
    }
    next(): Token {
        return lexerPart0.next(this);
    }
    eof(): boolean {
        return lexerPart0.eof(this);
    }
    span(): Span {
        return lexerPart1.span(this);
    }
    makeSpan(start: number, startLine: number, startCol: number): Span {
        return lexerPart1.makeSpan(this, start, startLine, startCol);
    }
    peekChar(offset: number = 0): string {
        return lexerPart1.peekChar(this, offset);
    }
    advance(): string {
        return lexerPart1.advance(this);
    }
    nextToken(): Token | null {
        return lexerPart1.nextToken(this);
    }
    isIdStart(ch: string): boolean {
        return lexerPart2.isIdStart(this, ch);
    }
    isIdContinue(ch: string): boolean {
        return lexerPart2.isIdContinue(this, ch);
    }
    lexIdOrKeyword(start: number, startLine: number, startCol: number): Token {
        return lexerPart2.lexIdOrKeyword(this, start, startLine, startCol);
    }
    lexNumber(start: number, startLine: number, startCol: number): Token {
        return lexerPart3.lexNumber(this, start, startLine, startCol);
    }
    peekSuffix(): string {
        return lexerPart3.peekSuffix(this);
    }
    advanceN(count: number): string {
        return lexerPart1.advanceN(this, count);
    }
    isHexDigit(ch: string): boolean {
        return lexerPart3.isHexDigit(this, ch);
    }
    lexCharLiteral(start: number, startLine: number, startCol: number): Token {
        return lexerPart4.lexCharLiteral(this, start, startLine, startCol);
    }
    lexStringLiteral(start: number, startLine: number, startCol: number): Token {
        return lexerPart4.lexStringLiteral(this, start, startLine, startCol);
    }
    lexOperator(start: number, startLine: number, startCol: number): Token {
        return lexerPart5.lexOperator(this, start, startLine, startCol);
    }
    skipLineComment(): void {
        return lexerPart6.skipLineComment(this);
    }
    skipBlockComment(): void {
        return lexerPart6.skipBlockComment(this);
    }
    // Collapse multi-word type keywords like "signed long long" → "kw_signed_long_long"
    collapseTypeKeywords(): void {
        return lexerPart7.collapseTypeKeywords(this);
    }
}
