import type { LexerInternals } from "./lexer-context";

export function skipLineComment(context: LexerInternals): void {
    while (!context.eof() && context.peekChar() !== "\n") {
        context.advance();
    }
}

export function skipBlockComment(context: LexerInternals): void {
    context.advance(); // *
    while (!context.eof()) {
        if (context.peekChar() === "*" && context.peekChar(1) === "/") {
            context.advance(); // *
            context.advance(); // /
            return;
        }
        context.advance();
    }
}
