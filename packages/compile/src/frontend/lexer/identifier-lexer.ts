import { KEYWORDS } from "./keywords";
import type { LexerInternals } from "./lexer-context";
import type { Token, TokenKind } from "./tokens";

export function isIdStart(context: LexerInternals, ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

export function isIdContinue(context: LexerInternals, ch: string): boolean {
    return context.isIdStart(ch) || (ch >= "0" && ch <= "9");
}

export function lexIdOrKeyword(context: LexerInternals, start: number, startLine: number, startCol: number): Token {
    let text = "";
    while (!context.eof() && context.isIdContinue(context.peekChar())) {
        text += context.advance();
    }
    const kw = KEYWORDS[text];
    const kind: TokenKind = kw ?? "identifier";
    return { kind, text, span: context.makeSpan(start, startLine, startCol) };
}
