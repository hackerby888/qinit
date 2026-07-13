import type { Expression, TypeSpec, UnaryOp } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parseUnary(context: ParserInternals): Expression {
    const tok = context.peek();
    // new/delete expressions: contracts have no heap. Report once with the real reason, then
    if ((tok.kind === "identifier" && tok.text === "new") || tok.kind === "kw_delete") {
        context.diagnostics.push({
            severity: "error",
            message: `dynamic memory allocation ('${tok.text}') is not allowed in a contract`,
            span: tok.span,
        });
        while (!context.eof() && context.peek().kind !== "semicolon" && context.peek().kind !== "r_brace") {
            context.next();
        }
        return { kind: "int_literal", value: "0", span: tok.span };
    }
    // Prefix operators
    if (tok.kind === "bang" ||
        tok.kind === "tilde" ||
        tok.kind === "minus" ||
        tok.kind === "plus" ||
        tok.kind === "star" ||
        tok.kind === "amp") {
        const opMap: Record<string, UnaryOp> = {
            bang: "!",
            tilde: "~",
            minus: "-",
            plus: "+",
            star: "*",
            amp: "&",
        };
        const operator = opMap[tok.kind];
        if (operator) {
            context.next();
            const argument = context.parseUnary();
            return { kind: "unary_op", operator, argument, span: tok.span };
        }
    }
    // Prefix ++ / --
    if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
        const operator = tok.kind === "plus_plus" ? ("++" as const) : ("--" as const);
        context.next();
        const argument = context.parseUnary();
        return { kind: "prefix_op", operator, argument, span: tok.span };
    }
    // sizeof
    if (tok.kind === "kw_sizeof") {
        return context.parseSizeof();
    }
    // Cast: (type)expr
    if (tok.kind === "l_paren" && context.isTypeCast()) {
        return context.parseCast();
    }
    return context.parsePostfix();
}

export function parsePostfix(context: ParserInternals): Expression {
    let expression = context.parsePrimaryExpression();
    while (!context.eof()) {
        const tok = context.peek();
        // Brace-init / aggregate construction: TypeName{ a, b, c } (e.g. Logger{ idx, code, 0 }). Only an
        if (tok.kind === "l_brace" &&
            (expression.kind === "identifier" || expression.kind === "qualified_name")) {
            const name = expression.kind === "identifier" ? expression.name : `${expression.namespace}::${expression.name}`;
            context.next(); // {
            const callArguments: Expression[] = [];
            while (!context.eof() && context.peek().kind !== "r_brace") {
                callArguments.push(context.parseBraceArg());
                if (!context.tryConsume("comma"))
                    break;
            }
            context.expect("r_brace", "brace init");
            expression = { kind: "construct", type: { kind: "name", name }, callArguments, span: expression.span };
            continue;
        }
        // .member or ->member
        if (tok.kind === "dot" || tok.kind === "arrow") {
            const arrow = tok.kind === "arrow";
            context.next();
            const memberTok = context.expect("identifier", "member access");
            if (memberTok) {
                expression = {
                    kind: "member_access",
                    object: expression,
                    member: memberTok.text,
                    arrow,
                    span: expression.span,
                };
            }
            continue;
        }
        // [index] (internal/QPI framework use)
        if (tok.kind === "l_bracket") {
            context.next();
            const index = context.parseExpression();
            context.expect("r_bracket", "subscript");
            expression = { kind: "subscript", object: expression, index, span: expression.span };
            continue;
        }
        // Function call: expr(args)
        if (tok.kind === "l_paren") {
            context.next();
            const callArguments = context.parseArgList();
            context.expect("r_paren", "call args");
            expression = { kind: "call", callee: expression, callArguments, span: expression.span };
            continue;
        }
        // Template call: expr<T>(args) — only when the lookahead genuinely matches `< types > (`.
        if (tok.kind === "l_angle" && context.looksLikeTemplateArgs()) {
            context.next();
            const templateArguments: TypeSpec[] = [];
            while (!context.eof() && context.peek().kind !== "r_angle") {
                const argStart = context.peek().span;
                const kind = context.peek().kind;
                // Function-template arguments may be non-type values (`irootK64<2>` and
                // `irootNewtonStep<k>`), just like class-template arguments. Preserve the
                if (kind === "int_literal" ||
                    kind === "l_paren" ||
                    kind === "kw_sizeof" ||
                    kind === "char_literal" ||
                    kind === "minus" ||
                    kind === "tilde" ||
                    kind === "kw_true" ||
                    kind === "kw_false" ||
                    context.templateArgIsExpr()) {
                    templateArguments.push({ kind: "expr_value", expression: context.parseShift(), span: argStart });
                }
                else {
                    templateArguments.push(context.parseTypeSpec());
                }
                if (!context.tryConsume("comma"))
                    break;
            }
            context.consumeAngleClose();
            context.expect("l_paren", "template call args");
            const callArguments = context.parseArgList();
            context.expect("r_paren", "template call args close");
            expression = { kind: "template_call", callee: expression, templateArguments, callArguments, span: expression.span };
            continue;
        }
        // Postfix ++ / --
        if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
            const operator = tok.kind === "plus_plus" ? ("++" as const) : ("--" as const);
            context.next();
            expression = { kind: "postfix_op", operator, argument: expression, span: expression.span };
            continue;
        }
        break;
    }
    return expression;
}

export function looksLikeTemplateArgs(context: ParserInternals): boolean {
    const save = (context.lex as any).index;
    context.next(); // consume `<`
    let depth = 1;
    let ok = true;
    let guard = 0;
    while (!context.eof() && depth > 0 && guard++ < 200) {
        const kind = context.peek().kind;
        if (kind === "l_angle") {
            depth++;
            context.next();
            continue;
        }
        if (kind === "r_angle") {
            depth--;
            context.next();
            continue;
        }
        if (kind === "r_shift") {
            depth -= 2;
            context.next();
            continue;
        }
        // Tokens that can't appear inside a template-argument list → it's a comparison.
        if (kind === "semicolon" ||
            kind === "l_brace" ||
            kind === "r_brace" ||
            kind === "eq" ||
            kind === "plus" ||
            kind === "minus" ||
            kind === "slash" ||
            kind === "percent" ||
            kind === "question" ||
            kind === "amp_amp" ||
            kind === "pipe_pipe" ||
            kind === "eq_eq" ||
            kind === "not_eq" ||
            kind === "l_paren" ||
            kind === "r_paren") {
            ok = false;
            break;
        }
        context.next();
    }
    const followedByParen = ok && depth <= 0 && context.peek().kind === "l_paren";
    (context.lex as any).index = save;
    return followedByParen;
}

export function parseBraceArg(context: ParserInternals): Expression {
    if (context.peek().kind === "l_brace") {
        const start = context.next().span; // {
        const expressions: Expression[] = [];
        while (!context.eof() && context.peek().kind !== "r_brace") {
            expressions.push(context.parseBraceArg());
            if (!context.tryConsume("comma"))
                break;
        }
        context.expect("r_brace", "initializer list");
        return { kind: "initializer_list", expressions, span: start };
    }
    return context.parseExpression();
}
