import { AstKind, TokenKind } from "../../enums";
import type { Expression, Statement } from "../../ast";
import { isTypeKeyword } from "../../lexer";
import type { Parser } from "./parser";

export class StatementParser {
    constructor(private readonly parser: Parser) {}

    parseStatement(): Statement {
        const tok = this.parser.state.peek();
        // Compound
        if (tok.kind === TokenKind.L_BRACE) {
            this.parser.state.next();
            return this.parser.statements.parseCompoundStatement();
        }
        // Control flow
        if (tok.kind === TokenKind.KW_IF) {
            return this.parser.statements.parseIf();
        }
        if (tok.kind === TokenKind.KW_FOR) {
            return this.parser.statements.parseFor();
        }
        if (tok.kind === TokenKind.KW_WHILE) {
            return this.parser.statements.parseWhile();
        }
        if (tok.kind === TokenKind.KW_DO) {
            return this.parser.statements.parseDoWhile();
        }
        if (tok.kind === TokenKind.KW_SWITCH) {
            return this.parser.statements.parseSwitch();
        }
        if (tok.kind === TokenKind.KW_CASE) {
            return this.parser.statements.parseCase();
        }
        if (tok.kind === TokenKind.KW_DEFAULT) {
            return this.parser.statements.parseDefault();
        }
        if (tok.kind === TokenKind.KW_BREAK) {
            this.parser.state.next();
            this.parser.state.expect(TokenKind.SEMICOLON, "break");
            return { kind: AstKind.BREAK, span: tok.span };
        }
        if (tok.kind === TokenKind.KW_CONTINUE) {
            this.parser.state.next();
            this.parser.state.expect(TokenKind.SEMICOLON, "continue");
            return { kind: AstKind.CONTINUE, span: tok.span };
        }
        if (tok.kind === TokenKind.KW_RETURN) {
            return this.parser.statements.parseReturn();
        }
        if (tok.kind === TokenKind.KW_GOTO) {
            this.parser.state.next();
            const labelTok = this.parser.state.expect(TokenKind.IDENTIFIER, "goto label");
            this.parser.state.expect(TokenKind.SEMICOLON, "goto");
            return { kind: AstKind.GOTO, label: labelTok?.text ?? "", span: tok.span };
        }
        // Label: identifier :
        if (tok.kind === TokenKind.IDENTIFIER && this.parser.state.peek(1).kind === TokenKind.COLON) {
            this.parser.state.next();
            this.parser.state.next(); // :
            return { kind: AstKind.LABEL, name: tok.text, span: tok.span };
        }
        // static_assert
        if (tok.kind === TokenKind.KW_STATIC_ASSERT) {
            const sa = this.parser.declarations.parseStaticAssertDecl();
            return { kind: AstKind.STATIC_ASSERT, condition: sa.condition, message: sa.message, span: sa.span };
        }
        // Declaration (type keyword or modifier)
        if (isTypeKeyword(tok.kind) ||
            tok.kind === TokenKind.KW_CONSTEXPR ||
            tok.kind === TokenKind.KW_STATIC ||
            tok.kind === TokenKind.KW_INLINE ||
            tok.kind === TokenKind.KW_TYPEDEF ||
            tok.kind === TokenKind.KW_USING ||
            tok.kind === TokenKind.KW_ENUM ||
            tok.kind === TokenKind.KW_STRUCT ||
            tok.kind === TokenKind.KW_CLASS ||
            tok.kind === TokenKind.KW_UNION ||
            tok.kind === TokenKind.KW_NAMESPACE ||
            tok.kind === TokenKind.KW_TEMPLATE ||
            tok.kind === TokenKind.KW_EXTERN ||
            tok.kind === TokenKind.KW_UNSIGNED ||
            tok.kind === TokenKind.KW_SIGNED ||
            tok.kind === TokenKind.KW_LONG ||
            this.parser.expressions.looksLikeLocalDecl()) {
            const declaration = this.parser.declarations.parseDeclaration();
            if (declaration) {
                // Drain queued declarators into a synthetic compound statement.
                if (this.parser.state.pendingDeclarations.length) {
                    const statements: Statement[] = [{ kind: AstKind.DECLARATION, declaration, span: this.parser.state.peek().span }];
                    while (this.parser.state.pendingDeclarations.length) {
                        const declaration = this.parser.state.pendingDeclarations.shift()!;
                        statements.push({ kind: AstKind.DECLARATION, declaration: declaration, span: (declaration as any).span ?? this.parser.state.peek().span });
                    }
                    return {
                        kind: AstKind.COMPOUND,
                        body: statements,
                        span: this.parser.state.peek().span,
                        synthetic: true,
                    } as Statement;
                }
                return { kind: AstKind.DECLARATION, declaration, span: this.parser.state.peek().span };
            }
        }
        // Expression statement
        if (tok.kind === TokenKind.SEMICOLON) {
            this.parser.state.next();
            return { kind: AstKind.EMPTY, span: tok.span };
        }
        const expression = this.parser.expressions.parseExpression();
        // Label after expression: expr : (unlikely but possible for case-like constructs)
        if (this.parser.state.peek().kind === TokenKind.COLON && expression.kind === AstKind.IDENTIFIER) {
            this.parser.state.next(); // :
            return { kind: AstKind.LABEL, name: (expression as any).name, span: expression.span };
        }
        this.parser.state.expect(TokenKind.SEMICOLON, "expression statement");
        return { kind: AstKind.EXPRESSION, expression, span: expression.span };
    }

    parseCompoundStatement(): Statement {
        const start = this.parser.state.peek(-1)?.span || this.parser.state.peek().span;
        const body: Statement[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
            const statement = this.parser.statements.parseStatement();
            if (statement) {
                body.push(statement);
            }
        }
        this.parser.state.expect(TokenKind.R_BRACE, "compound close");
        return { kind: AstKind.COMPOUND, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseIf(): Statement {
        const start = this.parser.state.next().span; // if
        this.parser.state.expect(TokenKind.L_PAREN, "if cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect(TokenKind.R_PAREN, "if cond close");
        const thenStmt = this.parser.statements.parseStatement();
        let elseStmt: Statement | undefined;
        if (this.parser.state.tryConsumeKeyword("else")) {
            elseStmt = this.parser.statements.parseStatement();
        }
        return { kind: AstKind.IF, condition, then: thenStmt, else_: elseStmt, span: this.parser.recovery.makeSpan(start) };
    }

    parseFor(): Statement {
        const start = this.parser.state.next().span; // for
        this.parser.state.expect(TokenKind.L_PAREN, "for");
        let initializer: Statement | undefined;
        let condition: Expression | undefined;
        let update: Expression | undefined;
        // for (;;)
        if (this.parser.state.peek().kind !== TokenKind.SEMICOLON) {
            // Could be a declaration (`for (sint64 i = 0; ...)`) or an expression init.
            if (isTypeKeyword(this.parser.state.peek().kind) || this.parser.expressions.looksLikeLocalDecl()) {
                const declaration = this.parser.declarations.parseDeclaration();
                if (declaration) {
                    initializer = { kind: AstKind.DECLARATION, declaration, span: declaration.span ?? this.parser.state.peek().span };
                }
            }
            else {
                // the init clause may be a comma sequence of assignments: for (a = x, b = 0; ...).
                const expression = this.parser.expressions.parseCommaSequence();
                initializer = { kind: AstKind.EXPRESSION, expression, span: expression.span };
            }
        }
        // parseDeclaration may or may not consume the trailing ';'; consume it here if still present.
        if (this.parser.state.peek().kind === TokenKind.SEMICOLON)
            this.parser.state.next();
        if (this.parser.state.peek().kind !== TokenKind.SEMICOLON) {
            condition = this.parser.expressions.parseExpression();
        }
        this.parser.state.expect(TokenKind.SEMICOLON, "for cond");
        if (this.parser.state.peek().kind !== TokenKind.R_PAREN) {
            update = this.parser.expressions.parseCommaSequence();
        }
        this.parser.state.expect(TokenKind.R_PAREN, "for close");
        const body = this.parser.statements.parseStatement();
        return { kind: AstKind.FOR, initializer, condition, update, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseWhile(): Statement {
        const start = this.parser.state.next().span; // while
        this.parser.state.expect(TokenKind.L_PAREN, "while cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect(TokenKind.R_PAREN, "while cond close");
        const body = this.parser.statements.parseStatement();
        return { kind: AstKind.WHILE, condition, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseDoWhile(): Statement {
        const start = this.parser.state.next().span; // do
        const body = this.parser.statements.parseStatement();
        this.parser.state.expect(TokenKind.KW_WHILE, "do-while while");
        this.parser.state.expect(TokenKind.L_PAREN, "do-while cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect(TokenKind.R_PAREN, "do-while cond close");
        this.parser.state.expect(TokenKind.SEMICOLON, "do-while");
        return { kind: AstKind.DO_WHILE, body, condition, span: this.parser.recovery.makeSpan(start) };
    }

    parseSwitch(): Statement {
        const start = this.parser.state.next().span; // switch
        this.parser.state.expect(TokenKind.L_PAREN, "switch cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect(TokenKind.R_PAREN, "switch cond close");
        const body = this.parser.statements.parseStatement();
        return { kind: AstKind.SWITCH, condition, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseCase(): Statement {
        const start = this.parser.state.next().span; // case
        const value = this.parser.expressions.parseExpression();
        this.parser.state.expect(TokenKind.COLON, "case");
        return { kind: AstKind.CASE, value, span: this.parser.recovery.makeSpan(start) };
    }

    parseDefault(): Statement {
        const start = this.parser.state.next().span; // default
        this.parser.state.expect(TokenKind.COLON, "default");
        return { kind: AstKind.DEFAULT, span: this.parser.recovery.makeSpan(start) };
    }

    parseReturn(): Statement {
        const start = this.parser.state.next().span; // return
        let value: Expression | undefined;
        if (this.parser.state.peek().kind !== TokenKind.SEMICOLON) {
            value = this.parser.expressions.parseExpression();
        }
        this.parser.state.expect(TokenKind.SEMICOLON, "return");
        return { kind: AstKind.RETURN, value, span: this.parser.recovery.makeSpan(start) };
    }
}
