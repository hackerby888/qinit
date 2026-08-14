import { TokenKind } from "../../shared/enums";
import { KEYWORDS } from "./keywords";
import type { Lexer } from "./lexer";
import type { Token } from "./tokens";

export function isIdStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

export function isIdContinue(lexer: Lexer, ch: string): boolean {
    return lexer.isIdStart(ch) || (ch >= "0" && ch <= "9");
}

export function lexIdOrKeyword(
    lexer: Lexer,
    start: number,
    startLine: number,
    startCol: number,
): Token {
    let text = "";
    while (!lexer.eof() && lexer.isIdContinue(lexer.peekChar())) {
        text += lexer.advance();
    }
    const kw = KEYWORDS[text];
    const kind: TokenKind = kw ?? TokenKind.IDENTIFIER;
    return { kind, text, span: lexer.makeSpan(start, startLine, startCol) };
}
