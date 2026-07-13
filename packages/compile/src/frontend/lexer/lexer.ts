import type { Span } from "../../ast";
import type { LexerInternals } from "./lexer-context";
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
    private src: string;
    private pos: number = 0;
    private line: number = 1;
    private column: number = 1;
    private tokens: Token[] = [];
    private index: number = 0;
    constructor(src: string) {
        this.src = src;
    }
    // Tokenize the entire source and return an array. Also collapses multi-word type keywords.
    tokenize(): Token[] {
        return lexerPart0.tokenize(this as unknown as LexerInternals);
    }
    // Get the token stream (for parser)
    getTokens(): Token[] {
        return lexerPart0.getTokens(this as unknown as LexerInternals);
    }
    // Reset for streaming parse
    reset(): void {
        return lexerPart0.reset(this as unknown as LexerInternals);
    }
    // Streaming interface
    peek(offset: number = 0): Token {
        return lexerPart0.peek(this as unknown as LexerInternals, offset);
    }
    next(): Token {
        return lexerPart0.next(this as unknown as LexerInternals);
    }
    private eof(): boolean {
        return lexerPart0.eof(this as unknown as LexerInternals);
    }
    private span(): Span {
        return lexerPart1.span(this as unknown as LexerInternals);
    }
    private makeSpan(start: number, startLine: number, startCol: number): Span {
        return lexerPart1.makeSpan(this as unknown as LexerInternals, start, startLine, startCol);
    }
    private peekChar(offset: number = 0): string {
        return lexerPart1.peekChar(this as unknown as LexerInternals, offset);
    }
    private advance(): string {
        return lexerPart1.advance(this as unknown as LexerInternals);
    }
    private nextToken(): Token | null {
        return lexerPart1.nextToken(this as unknown as LexerInternals);
    }
    private isIdStart(ch: string): boolean {
        return lexerPart2.isIdStart(this as unknown as LexerInternals, ch);
    }
    private isIdContinue(ch: string): boolean {
        return lexerPart2.isIdContinue(this as unknown as LexerInternals, ch);
    }
    private lexIdOrKeyword(start: number, startLine: number, startCol: number): Token {
        return lexerPart2.lexIdOrKeyword(this as unknown as LexerInternals, start, startLine, startCol);
    }
    private lexNumber(start: number, startLine: number, startCol: number): Token {
        return lexerPart3.lexNumber(this as unknown as LexerInternals, start, startLine, startCol);
    }
    private peekSuffix(): string {
        return lexerPart3.peekSuffix(this as unknown as LexerInternals);
    }
    private advanceN(count: number): string {
        return lexerPart1.advanceN(this as unknown as LexerInternals, count);
    }
    private isHexDigit(ch: string): boolean {
        return lexerPart3.isHexDigit(this as unknown as LexerInternals, ch);
    }
    private lexCharLiteral(start: number, startLine: number, startCol: number): Token {
        return lexerPart4.lexCharLiteral(this as unknown as LexerInternals, start, startLine, startCol);
    }
    private lexStringLiteral(start: number, startLine: number, startCol: number): Token {
        return lexerPart4.lexStringLiteral(this as unknown as LexerInternals, start, startLine, startCol);
    }
    private lexOperator(start: number, startLine: number, startCol: number): Token {
        return lexerPart5.lexOperator(this as unknown as LexerInternals, start, startLine, startCol);
    }
    private skipLineComment(): void {
        return lexerPart6.skipLineComment(this as unknown as LexerInternals);
    }
    private skipBlockComment(): void {
        return lexerPart6.skipBlockComment(this as unknown as LexerInternals);
    }
    // Collapse multi-word type keywords like "signed long long" → "kw_signed_long_long"
    private collapseTypeKeywords(): void {
        return lexerPart7.collapseTypeKeywords(this as unknown as LexerInternals);
    }
}
