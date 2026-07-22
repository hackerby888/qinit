import type { Expression, Statement } from "../../ast";
import { isTypeKeyword } from "../../lexer";
import type { Parser } from "./parser";

export class StatementParser {
    constructor(private readonly parser: Parser) {}

    parseStatement(): Statement {
        const tok = this.parser.state.peek();
        // Compound
        if (tok.kind === "l_brace") {
            this.parser.state.next();
            return this.parser.statements.parseCompoundStatement();
        }
        // Control flow
        if (tok.kind === "kw_if") {
            return this.parser.statements.parseIf();
        }
        if (tok.kind === "kw_for") {
            return this.parser.statements.parseFor();
        }
        if (tok.kind === "kw_while") {
            return this.parser.statements.parseWhile();
        }
        if (tok.kind === "kw_do") {
            return this.parser.statements.parseDoWhile();
        }
        if (tok.kind === "kw_switch") {
            return this.parser.statements.parseSwitch();
        }
        if (tok.kind === "kw_case") {
            return this.parser.statements.parseCase();
        }
        if (tok.kind === "kw_default") {
            return this.parser.statements.parseDefault();
        }
        if (tok.kind === "kw_break") {
            this.parser.state.next();
            this.parser.state.expect("semicolon", "break");
            return { kind: "break", span: tok.span };
        }
        if (tok.kind === "kw_continue") {
            this.parser.state.next();
            this.parser.state.expect("semicolon", "continue");
            return { kind: "continue", span: tok.span };
        }
        if (tok.kind === "kw_return") {
            return this.parser.statements.parseReturn();
        }
        if (tok.kind === "kw_goto") {
            this.parser.state.next();
            const labelTok = this.parser.state.expect("identifier", "goto label");
            this.parser.state.expect("semicolon", "goto");
            return { kind: "goto", label: labelTok?.text ?? "", span: tok.span };
        }
        // Label: identifier :
        if (tok.kind === "identifier" && this.parser.state.peek(1).kind === "colon") {
            this.parser.state.next();
            this.parser.state.next(); // :
            return { kind: "label", name: tok.text, span: tok.span };
        }
        // static_assert
        if (tok.kind === "kw_static_assert") {
            const sa = this.parser.declarations.parseStaticAssertDecl();
            return { kind: "static_assert", condition: sa.condition, message: sa.message, span: sa.span };
        }
        // Declaration (type keyword or modifier)
        if (isTypeKeyword(tok.kind) ||
            tok.kind === "kw_constexpr" ||
            tok.kind === "kw_static" ||
            tok.kind === "kw_inline" ||
            tok.kind === "kw_typedef" ||
            tok.kind === "kw_using" ||
            tok.kind === "kw_enum" ||
            tok.kind === "kw_struct" ||
            tok.kind === "kw_class" ||
            tok.kind === "kw_union" ||
            tok.kind === "kw_namespace" ||
            tok.kind === "kw_template" ||
            tok.kind === "kw_extern" ||
            tok.kind === "kw_unsigned" ||
            tok.kind === "kw_signed" ||
            tok.kind === "kw_long" ||
            this.parser.expressions.looksLikeLocalDecl()) {
            const declaration = this.parser.declarations.parseDeclaration();
            if (declaration) {
                // Drain queued declarators into a synthetic compound statement.
                if (this.parser.state.pendingDeclarations.length) {
                    const statements: Statement[] = [{ kind: "declaration", declaration, span: this.parser.state.peek().span }];
                    while (this.parser.state.pendingDeclarations.length) {
                        const declaration = this.parser.state.pendingDeclarations.shift()!;
                        statements.push({ kind: "declaration", declaration: declaration, span: (declaration as any).span ?? this.parser.state.peek().span });
                    }
                    return {
                        kind: "compound",
                        body: statements,
                        span: this.parser.state.peek().span,
                        synthetic: true,
                    } as Statement;
                }
                return { kind: "declaration", declaration, span: this.parser.state.peek().span };
            }
        }
        // Expression statement
        if (tok.kind === "semicolon") {
            this.parser.state.next();
            return { kind: "empty", span: tok.span };
        }
        const expression = this.parser.expressions.parseExpression();
        // Label after expression: expr : (unlikely but possible for case-like constructs)
        if (this.parser.state.peek().kind === "colon" && expression.kind === "identifier") {
            this.parser.state.next(); // :
            return { kind: "label", name: (expression as any).name, span: expression.span };
        }
        this.parser.state.expect("semicolon", "expression statement");
        return { kind: "expression", expression, span: expression.span };
    }

    parseCompoundStatement(): Statement {
        const start = this.parser.state.peek(-1)?.span || this.parser.state.peek().span;
        const body: Statement[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
            const statement = this.parser.statements.parseStatement();
            if (statement) {
                body.push(statement);
            }
        }
        this.parser.state.expect("r_brace", "compound close");
        return { kind: "compound", body, span: this.parser.recovery.makeSpan(start) };
    }

    parseIf(): Statement {
        const start = this.parser.state.next().span; // if
        this.parser.state.expect("l_paren", "if cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect("r_paren", "if cond close");
        const thenStmt = this.parser.statements.parseStatement();
        let elseStmt: Statement | undefined;
        if (this.parser.state.tryConsumeKeyword("else")) {
            elseStmt = this.parser.statements.parseStatement();
        }
        return { kind: "if", condition, then: thenStmt, else_: elseStmt, span: this.parser.recovery.makeSpan(start) };
    }

    parseFor(): Statement {
        const start = this.parser.state.next().span; // for
        this.parser.state.expect("l_paren", "for");
        let initializer: Statement | undefined;
        let condition: Expression | undefined;
        let update: Expression | undefined;
        // for (;;)
        if (this.parser.state.peek().kind !== "semicolon") {
            // Could be a declaration (`for (sint64 i = 0; ...)`) or an expression init.
            if (isTypeKeyword(this.parser.state.peek().kind) || this.parser.expressions.looksLikeLocalDecl()) {
                const declaration = this.parser.declarations.parseDeclaration();
                if (declaration) {
                    initializer = { kind: "declaration", declaration, span: declaration.span ?? this.parser.state.peek().span };
                }
            }
            else {
                // the init clause may be a comma sequence of assignments: for (a = x, b = 0; ...).
                const expression = this.parser.expressions.parseCommaSequence();
                initializer = { kind: "expression", expression, span: expression.span };
            }
        }
        // parseDeclaration may or may not consume the trailing ';'; consume it here if still present.
        if (this.parser.state.peek().kind === "semicolon")
            this.parser.state.next();
        if (this.parser.state.peek().kind !== "semicolon") {
            condition = this.parser.expressions.parseExpression();
        }
        this.parser.state.expect("semicolon", "for cond");
        if (this.parser.state.peek().kind !== "r_paren") {
            update = this.parser.expressions.parseCommaSequence();
        }
        this.parser.state.expect("r_paren", "for close");
        const body = this.parser.statements.parseStatement();
        return { kind: "for", initializer, condition, update, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseWhile(): Statement {
        const start = this.parser.state.next().span; // while
        this.parser.state.expect("l_paren", "while cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect("r_paren", "while cond close");
        const body = this.parser.statements.parseStatement();
        return { kind: "while", condition, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseDoWhile(): Statement {
        const start = this.parser.state.next().span; // do
        const body = this.parser.statements.parseStatement();
        this.parser.state.expect("kw_while", "do-while while");
        this.parser.state.expect("l_paren", "do-while cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect("r_paren", "do-while cond close");
        this.parser.state.expect("semicolon", "do-while");
        return { kind: "do_while", body, condition, span: this.parser.recovery.makeSpan(start) };
    }

    parseSwitch(): Statement {
        const start = this.parser.state.next().span; // switch
        this.parser.state.expect("l_paren", "switch cond");
        const condition = this.parser.expressions.parseExpression();
        this.parser.state.expect("r_paren", "switch cond close");
        const body = this.parser.statements.parseStatement();
        return { kind: "switch", condition, body, span: this.parser.recovery.makeSpan(start) };
    }

    parseCase(): Statement {
        const start = this.parser.state.next().span; // case
        const value = this.parser.expressions.parseExpression();
        this.parser.state.expect("colon", "case");
        return { kind: "case", value, span: this.parser.recovery.makeSpan(start) };
    }

    parseDefault(): Statement {
        const start = this.parser.state.next().span; // default
        this.parser.state.expect("colon", "default");
        return { kind: "default", span: this.parser.recovery.makeSpan(start) };
    }

    parseReturn(): Statement {
        const start = this.parser.state.next().span; // return
        let value: Expression | undefined;
        if (this.parser.state.peek().kind !== "semicolon") {
            value = this.parser.expressions.parseExpression();
        }
        this.parser.state.expect("semicolon", "return");
        return { kind: "return", value, span: this.parser.recovery.makeSpan(start) };
    }
}
