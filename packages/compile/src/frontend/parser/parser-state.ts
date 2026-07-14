import type { Declaration } from "../../ast";
import { Lexer } from "../../lexer";
import type { Token, TokenKind } from "../../lexer";
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

        if (tokens.length === 0 || tokens[tokens.length - 1].kind !== "eof") {
            tokens.push({
                kind: "eof",
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
        return this.peek().kind === "eof";
    }

    expect(kind: TokenKind, context: string): Token | null {
        const token = this.peek();

        if (token.kind === kind) {
            return this.next();
        }

        this.diagnostics.push({
            severity: "error",
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

        if (token.kind === "r_angle") {
            this.next();
            return;
        }

        if (token.kind === "r_shift") {
            this.tokens[tokenIndex] = {
                kind: "r_angle",
                text: ">",
                span: token.span,
            };
            this.lastToken = token;
            return;
        }

        if (token.kind === "gt_eq") {
            this.tokens[tokenIndex] = {
                kind: "eq",
                text: "=",
                span: token.span,
            };
            this.lastToken = token;
            return;
        }

        this.expect("r_angle", "template close");
    }
}
