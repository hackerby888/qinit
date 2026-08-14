import type { Span } from "../../ast";
import type { Token } from "./tokens";
import * as tokenStream from "./token-stream";
import * as scanner from "./scanner";
import * as identifierLexer from "./identifier-lexer";
import * as numberLexer from "./number-lexer";
import * as literalLexer from "./literal-lexer";
import * as operatorLexer from "./operator-lexer";
import * as commentLexer from "./comment-lexer";
import * as typeKeywordCollapse from "./type-keyword-collapse";

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
        return tokenStream.tokenize(this);
    }
    // Get the token stream (for parser)
    getTokens(): Token[] {
        return tokenStream.getTokens(this);
    }
    // Reset for streaming parse
    reset(): void {
        return tokenStream.reset(this);
    }
    // Streaming interface
    peek(offset: number = 0): Token {
        return tokenStream.peek(this, offset);
    }
    next(): Token {
        return tokenStream.next(this);
    }
    eof(): boolean {
        return tokenStream.eof(this);
    }
    span(): Span {
        return scanner.span(this);
    }
    makeSpan(start: number, startLine: number, startCol: number): Span {
        return scanner.makeSpan(this, start, startLine, startCol);
    }
    peekChar(offset: number = 0): string {
        return scanner.peekChar(this, offset);
    }
    advance(): string {
        return scanner.advance(this);
    }
    nextToken(): Token | null {
        return scanner.nextToken(this);
    }
    isIdStart(ch: string): boolean {
        return identifierLexer.isIdStart(ch);
    }
    isIdContinue(ch: string): boolean {
        return identifierLexer.isIdContinue(this, ch);
    }
    lexIdOrKeyword(start: number, startLine: number, startCol: number): Token {
        return identifierLexer.lexIdOrKeyword(this, start, startLine, startCol);
    }
    lexNumber(start: number, startLine: number, startCol: number): Token {
        return numberLexer.lexNumber(this, start, startLine, startCol);
    }
    peekSuffix(): string {
        return numberLexer.peekSuffix(this);
    }
    advanceN(count: number): string {
        return scanner.advanceN(this, count);
    }
    isHexDigit(ch: string): boolean {
        return numberLexer.isHexDigit(ch);
    }
    lexCharLiteral(start: number, startLine: number, startCol: number): Token {
        return literalLexer.lexCharLiteral(this, start, startLine, startCol);
    }
    lexStringLiteral(start: number, startLine: number, startCol: number): Token {
        return literalLexer.lexStringLiteral(this, start, startLine, startCol);
    }
    lexOperator(start: number, startLine: number, startCol: number): Token {
        return operatorLexer.lexOperator(this, start, startLine, startCol);
    }
    skipLineComment(): void {
        return commentLexer.skipLineComment(this);
    }
    skipBlockComment(): void {
        return commentLexer.skipBlockComment(this);
    }
    // Collapse multi-word type keywords like "signed long long" → "kw_signed_long_long"
    collapseTypeKeywords(): void {
        return typeKeywordCollapse.collapseTypeKeywords(this);
    }
}
