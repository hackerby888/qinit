import type { Lexer } from "./lexer";

export function skipLineComment(lexer: Lexer): void {
    while (!lexer.eof() && lexer.peekChar() !== "\n") {
        lexer.advance();
    }
}

export function skipBlockComment(lexer: Lexer): void {
    lexer.advance(); // *
    while (!lexer.eof()) {
        if (lexer.peekChar() === "*" && lexer.peekChar(1) === "/") {
            lexer.advance(); // *
            lexer.advance(); // /
            return;
        }
        lexer.advance();
    }
}
