import type { Span } from "../../ast";
import { TokenKind } from "../../shared/enums";

// C++ lexer for the QPI subset. Produces a token stream consumed by the parser.
export { TokenKind };

export interface Token {
    kind: TokenKind;
    text: string;
    span: Span;
}
