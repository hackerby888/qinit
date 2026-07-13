import type { Span } from "../../ast";
import type { Token } from "./tokens";


export interface LexerInternals {
  src: string;
  pos: number;
  line: number;
  column: number;
  tokens: Token[];
  index: number;
  tokenize(): Token[];
  getTokens(): Token[];
  reset(): void;
  peek(offset?: number): Token;
  next(): Token;
  eof(): boolean;
  span(): Span;
  makeSpan(start: number, startLine: number, startCol: number): Span;
  peekChar(offset?: number): string;
  advance(): string;
  nextToken(): Token | null;
  isIdStart(ch: string): boolean;
  isIdContinue(ch: string): boolean;
  lexIdOrKeyword(start: number, startLine: number, startCol: number): Token;
  lexNumber(start: number, startLine: number, startCol: number): Token;
  peekSuffix(): string;
  advanceN(count: number): string;
  isHexDigit(ch: string): boolean;
  lexCharLiteral(start: number, startLine: number, startCol: number): Token;
  lexStringLiteral(start: number, startLine: number, startCol: number): Token;
  lexOperator(start: number, startLine: number, startCol: number): Token;
  skipLineComment(): void;
  skipBlockComment(): void;
  collapseTypeKeywords(): void;
}
