import type { Expression, Statement } from "../../ast";
import { isTypeKeyword } from "../../lexer";
import type { ParserInternals } from "./parser-context";

export function parseStatement(context: ParserInternals): Statement {
    const tok = context.peek();
    // Compound
    if (tok.kind === "l_brace") {
        context.next();
        return context.parseCompoundStatement();
    }
    // Control flow
    if (tok.kind === "kw_if") {
        return context.parseIf();
    }
    if (tok.kind === "kw_for") {
        return context.parseFor();
    }
    if (tok.kind === "kw_while") {
        return context.parseWhile();
    }
    if (tok.kind === "kw_do") {
        return context.parseDoWhile();
    }
    if (tok.kind === "kw_switch") {
        return context.parseSwitch();
    }
    if (tok.kind === "kw_case") {
        return context.parseCase();
    }
    if (tok.kind === "kw_default") {
        return context.parseDefault();
    }
    if (tok.kind === "kw_break") {
        context.next();
        context.expect("semicolon", "break");
        return { kind: "break", span: tok.span };
    }
    if (tok.kind === "kw_continue") {
        context.next();
        context.expect("semicolon", "continue");
        return { kind: "continue", span: tok.span };
    }
    if (tok.kind === "kw_return") {
        return context.parseReturn();
    }
    if (tok.kind === "kw_goto") {
        context.next();
        const labelTok = context.expect("identifier", "goto label");
        context.expect("semicolon", "goto");
        return { kind: "goto", label: labelTok?.text ?? "", span: tok.span };
    }
    // Label: identifier :
    if (tok.kind === "identifier" && context.peek(1).kind === "colon") {
        context.next();
        context.next(); // :
        return { kind: "label", name: tok.text, span: tok.span };
    }
    // static_assert
    if (tok.kind === "kw_static_assert") {
        const sa = context.parseStaticAssertDecl();
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
        context.looksLikeLocalDecl()) {
        const declaration = context.parseDeclaration();
        if (declaration) {
            // Multi-declarator statement (`sint64 a = 0, b = 0;`): parseVariableRest queues the extra declarators on `pending`, which only
            if (context.pending.length) {
                const statements: Statement[] = [{ kind: "declaration", declaration, span: context.peek().span }];
                while (context.pending.length) {
                    const declaration = context.pending.shift()!;
                    statements.push({ kind: "declaration", declaration: declaration, span: (declaration as any).span ?? context.peek().span });
                }
                return {
                    kind: "compound",
                    body: statements,
                    span: context.peek().span,
                    synthetic: true,
                } as Statement;
            }
            return { kind: "declaration", declaration, span: context.peek().span };
        }
    }
    // Expression statement
    if (tok.kind === "semicolon") {
        context.next();
        return { kind: "empty", span: tok.span };
    }
    const expression = context.parseExpression();
    // Label after expression: expr : (unlikely but possible for case-like constructs)
    if (context.peek().kind === "colon" && expression.kind === "identifier") {
        context.next(); // :
        return { kind: "label", name: (expression as any).name, span: expression.span };
    }
    context.expect("semicolon", "expression statement");
    return { kind: "expression", expression, span: expression.span };
}

export function parseCompoundStatement(context: ParserInternals): Statement {
    const start = context.peek(-1)?.span || context.peek().span;
    const body: Statement[] = [];
    while (!context.eof() && context.peek().kind !== "r_brace") {
        const statement = context.parseStatement();
        if (statement) {
            body.push(statement);
        }
    }
    context.expect("r_brace", "compound close");
    return { kind: "compound", body, span: context.makeSpan(start) };
}

export function parseIf(context: ParserInternals): Statement {
    const start = context.next().span; // if
    context.expect("l_paren", "if cond");
    const condition = context.parseExpression();
    context.expect("r_paren", "if cond close");
    const thenStmt = context.parseStatement();
    let elseStmt: Statement | undefined;
    if (context.tryConsumeKw("else")) {
        elseStmt = context.parseStatement();
    }
    return { kind: "if", condition, then: thenStmt, else_: elseStmt, span: context.makeSpan(start) };
}

export function parseFor(context: ParserInternals): Statement {
    const start = context.next().span; // for
    context.expect("l_paren", "for");
    let initializer: Statement | undefined;
    let condition: Expression | undefined;
    let update: Expression | undefined;
    // for (;;)
    if (context.peek().kind !== "semicolon") {
        // Could be a declaration (`for (sint64 i = 0; ...)`) or an expression init.
        if (isTypeKeyword(context.peek().kind) || context.looksLikeLocalDecl()) {
            const declaration = context.parseDeclaration();
            if (declaration) {
                initializer = { kind: "declaration", declaration, span: declaration.span ?? context.peek().span };
            }
        }
        else {
            // the init clause may be a comma sequence of assignments: for (a = x, b = 0; ...).
            const expression = context.parseCommaSequence();
            initializer = { kind: "expression", expression, span: expression.span };
        }
    }
    // parseDeclaration may or may not consume the trailing ';'; consume it here if still present.
    if (context.peek().kind === "semicolon")
        context.next();
    if (context.peek().kind !== "semicolon") {
        condition = context.parseExpression();
    }
    context.expect("semicolon", "for cond");
    if (context.peek().kind !== "r_paren") {
        update = context.parseCommaSequence();
    }
    context.expect("r_paren", "for close");
    const body = context.parseStatement();
    return { kind: "for", initializer, condition, update, body, span: context.makeSpan(start) };
}

export function parseWhile(context: ParserInternals): Statement {
    const start = context.next().span; // while
    context.expect("l_paren", "while cond");
    const condition = context.parseExpression();
    context.expect("r_paren", "while cond close");
    const body = context.parseStatement();
    return { kind: "while", condition, body, span: context.makeSpan(start) };
}

export function parseDoWhile(context: ParserInternals): Statement {
    const start = context.next().span; // do
    const body = context.parseStatement();
    context.expect("kw_while", "do-while while");
    context.expect("l_paren", "do-while cond");
    const condition = context.parseExpression();
    context.expect("r_paren", "do-while cond close");
    context.expect("semicolon", "do-while");
    return { kind: "do_while", body, condition, span: context.makeSpan(start) };
}

export function parseSwitch(context: ParserInternals): Statement {
    const start = context.next().span; // switch
    context.expect("l_paren", "switch cond");
    const condition = context.parseExpression();
    context.expect("r_paren", "switch cond close");
    const body = context.parseStatement();
    return { kind: "switch", condition, body, span: context.makeSpan(start) };
}

export function parseCase(context: ParserInternals): Statement {
    const start = context.next().span; // case
    const value = context.parseExpression();
    context.expect("colon", "case");
    return { kind: "case", value, span: context.makeSpan(start) };
}

export function parseDefault(context: ParserInternals): Statement {
    const start = context.next().span; // default
    context.expect("colon", "default");
    return { kind: "default", span: context.makeSpan(start) };
}

export function parseReturn(context: ParserInternals): Statement {
    const start = context.next().span; // return
    let value: Expression | undefined;
    if (context.peek().kind !== "semicolon") {
        value = context.parseExpression();
    }
    context.expect("semicolon", "return");
    return { kind: "return", value, span: context.makeSpan(start) };
}
