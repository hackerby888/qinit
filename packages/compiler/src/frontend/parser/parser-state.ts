import { DiagnosticSeverity, TokenKind } from "../../enums";
import type { Declaration } from "../../ast";
import { Lexer } from "../../lexer";
import type { Token } from "../../lexer";
import type { ParserDiagnostic } from "./parser-context";

export class ParserState {
    readonly lexer: Lexer;
    readonly diagnostics: ParserDiagnostic[] = [];
    readonly bodyDiagnostics: ParserDiagnostic[] = [];
    readonly pendingDeclarations: Declaration[] = [];

    templateAngleDepth = 0;
    lastToken: Token | null = null;

    constructor(tokens: Token[]) {
        this.lexer = new Lexer("");
        (this.lexer as any).tokens = tokens;
        (this.lexer as any).index = 0;

        if (tokens.length === 0 || tokens[tokens.length - 1].kind !== TokenKind.EOF) {
            tokens.push({
                kind: TokenKind.EOF,
                text: "",
                span: {
                    start: 0,
                    end: 0,
                    line: 0,
                    column: 0,
                },
            });
        }
    }

    get position(): number {
        return (this.lexer as any).index;
    }

    set position(position: number) {
        (this.lexer as any).index = position;
    }

    get tokens(): Token[] {
        return (this.lexer as any).tokens;
    }

    peek(offset = 0): Token {
        return this.lexer.peek(offset);
    }

    next(): Token {
        const token = this.lexer.next();
        this.lastToken = token;
        return token;
    }

    last(): Token {
        return this.lastToken ?? this.peek();
    }

    eof(): boolean {
        return this.peek().kind === TokenKind.EOF;
    }

    expect(kind: TokenKind, context: string): Token | null {
        const token = this.peek();

        if (token.kind === kind) {
            return this.next();
        }

        this.diagnostics.push({
            severity: DiagnosticSeverity.ERROR,
            message:
                "Expected " +
                kind +
                " but got " +
                token.kind +
                " (" +
                token.text +
                ") in " +
                context,
            span: token.span,
        });

        return null;
    }

    tryConsume(kind: TokenKind): Token | null {
        if (this.peek().kind === kind) {
            return this.next();
        }

        return null;
    }

    tryConsumeKeyword(keyword: string): Token | null {
        const token = this.peek();

        if (token.text === keyword) {
            return this.next();
        }

        return null;
    }

    consumeTemplateAngleClose(): void {
        const token = this.peek();
        const tokenIndex = this.position;

        if (token.kind === TokenKind.R_ANGLE) {
            this.next();
            return;
        }

        if (token.kind === TokenKind.R_SHIFT) {
            this.tokens[tokenIndex] = {
                kind: TokenKind.R_ANGLE,
                text: ">",
                span: token.span,
            };
            this.lastToken = token;
            return;
        }

        if (token.kind === TokenKind.GT_EQ) {
            this.tokens[tokenIndex] = {
                kind: TokenKind.EQ,
                text: "=",
                span: token.span,
            };
            this.lastToken = token;
            return;
        }

        this.expect(TokenKind.R_ANGLE, "template close");
    }
}
