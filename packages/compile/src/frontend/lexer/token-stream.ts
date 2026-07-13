import type { LexerInternals } from "./lexer-context";
import type { Token } from "./tokens";

export function tokenize(context: LexerInternals): Token[] {
    context.tokens = [];
    while (!context.eof()) {
        const tok = context.nextToken();
        if (tok) {
            context.tokens.push(tok);
        }
    }
    context.tokens.push({ kind: "eof", text: "", span: context.span() });
    context.collapseTypeKeywords();
    return context.tokens;
}

export function getTokens(context: LexerInternals): Token[] {
    return context.tokens;
}

export function reset(context: LexerInternals): void {
    context.index = 0;
}

export function peek(context: LexerInternals, offset: number = 0): Token {
    const index = context.index + offset;
    if (index >= context.tokens.length) {
        return context.tokens[context.tokens.length - 1]; // eof
    }
    return context.tokens[index];
}

export function next(context: LexerInternals): Token {
    const tok = context.peek();
    context.index++;
    return tok;
}

export function eof(context: LexerInternals): boolean {
    return context.pos >= context.src.length;
}
