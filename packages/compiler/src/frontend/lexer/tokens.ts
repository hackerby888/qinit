import type { Span } from "../../ast";
import { TokenKind } from "../../enums";

// C++ lexer for the QPI subset. Produces a token stream consumed by the parser.
export { TokenKind };

export interface Token {
    kind: TokenKind;
    text: string; // raw source text
    span: Span;
}
