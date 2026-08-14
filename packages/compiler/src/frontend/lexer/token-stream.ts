import { TokenKind } from "../../shared/enums";
import type { Lexer } from "./lexer";
import type { Token } from "./tokens";

export function tokenize(lexer: Lexer): Token[] {
    lexer.tokens = [];
    while (!lexer.eof()) {
        const tok = lexer.nextToken();
        if (tok) {
            lexer.tokens.push(tok);
        }
    }
    lexer.tokens.push({ kind: TokenKind.EOF, text: "", span: lexer.span() });
    lexer.collapseTypeKeywords();
    return lexer.tokens;
}

export function getTokens(lexer: Lexer): Token[] {
    return lexer.tokens;
}

export function reset(lexer: Lexer): void {
    lexer.index = 0;
}

export function peek(lexer: Lexer, offset: number = 0): Token {
    const index = lexer.index + offset;
    if (index >= lexer.tokens.length) {
        return lexer.tokens[lexer.tokens.length - 1]; // eof
    }
    return lexer.tokens[index];
}

export function next(lexer: Lexer): Token {
    const tok = lexer.peek();
    lexer.index++;
    return tok;
}

export function eof(lexer: Lexer): boolean {
    return lexer.pos >= lexer.src.length;
}
