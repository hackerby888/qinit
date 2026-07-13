import type { Expression } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parsePrimaryExpression(context: ParserInternals): Expression {
    const tok = context.peek();
    // Literals
    if (tok.kind === "int_literal") {
        context.next();
        // Split the u/l suffix off the digits — literal typing (width/signedness) reads it.
        const member = tok.text.match(/^(.+?)([uUlL]+)$/);
        if (member) {
            return { kind: "int_literal", value: member[1], suffix: member[2], span: tok.span };
        }
        return { kind: "int_literal", value: tok.text, span: tok.span };
    }
    if (tok.kind === "float_literal") {
        context.next();
        return { kind: "float_literal", value: tok.text, span: tok.span };
    }
    if (tok.kind === "string_literal") {
        context.next();
        // Adjacent string literals concatenate (C++ rule): static_assert(c, #fn "_locals too large").
        let value = tok.text.replace(/"/g, "");
        while (context.peek().kind === "string_literal") {
            value += context.next().text.replace(/"/g, "");
        }
        return { kind: "string_literal", value, span: tok.span };
    }
    if (tok.kind === "char_literal") {
        context.next();
        return { kind: "char_literal", value: context.parseCharValue(tok.text), span: tok.span };
    }
    if (tok.kind === "kw_true") {
        context.next();
        return { kind: "bool_literal", value: true, span: tok.span };
    }
    if (tok.kind === "kw_false") {
        context.next();
        return { kind: "bool_literal", value: false, span: tok.span };
    }
    if (tok.kind === "kw_nullptr") {
        context.next();
        return { kind: "nullptr_literal", span: tok.span };
    }
    // this
    if (tok.kind === "kw_this") {
        context.next();
        return { kind: "this", span: tok.span };
    }
    // Parenthesized expression
    if (tok.kind === "l_paren") {
        context.next();
        const savedGt = context.gtDisabled;
        context.gtDisabled = 0; // a `>` inside parens is a comparison again, even within a template list
        const expression = context.parseExpression();
        context.gtDisabled = savedGt;
        context.expect("r_paren", "paren expr");
        return { kind: "paren", expression, span: tok.span };
    }
    // Brace initializer: {a, b, c}
    if (tok.kind === "l_brace") {
        context.next();
        const savedGt = context.gtDisabled;
        context.gtDisabled = 0;
        const expressions: Expression[] = [];
        while (!context.eof() && context.peek().kind !== "r_brace") {
            expressions.push(context.parseExpression());
            if (!context.tryConsume("comma"))
                break;
        }
        context.gtDisabled = savedGt;
        context.expect("r_brace", "initializer list");
        return { kind: "initializer_list", expressions, span: tok.span };
    }
    // Identifier or qualified name
    const name = context.parseQualifiedName();
    if (name) {
        return { kind: "identifier", name, span: tok.span };
    }
    // Error recovery
    context.diagnostics.push({
        severity: "error",
        message: `Expected expression but got ${tok.kind} (${tok.text})`,
        span: tok.span,
    });
    context.next();
    return { kind: "int_literal", value: "0", span: tok.span };
}

export function parseCommaSequence(context: ParserInternals): Expression {
    const first = context.parseExpression();
    if (context.peek().kind !== "comma")
        return first;
    const expressions = [first];
    while (context.peek().kind === "comma") {
        context.next();
        expressions.push(context.parseExpression());
    }
    return { kind: "sequence", expressions, span: first.span };
}

export function looksLikeLocalDecl(context: ParserInternals): boolean {
    const t0 = context.peek().kind;
    if (t0 === "kw_const" || t0 === "kw_auto")
        return true;
    if (t0 !== "identifier")
        return false;
    // Skip a qualified type name: identifier (:: identifier)* — e.g. QPI::uint64 name.
    let index = 1;
    while (context.peek(index).kind === "d_colon" && context.peek(index + 1).kind === "identifier")
        index += 2;
    // Skip template arguments `<...>` so `ProposalWithAllVoteData<D, N>& p` is recognized as a decl, not read as a `<`
    if (context.peek(index).kind === "l_angle") {
        let depth = 0;
        let templateEndIndex = index;
        for (; !context.eof(); templateEndIndex++) {
            const kind = context.peek(templateEndIndex).kind;
            if (kind === "l_angle")
                depth++;
            else if (kind === "r_angle") {
                if (--depth === 0) {
                    templateEndIndex++;
                    break;
                }
            }
            else if (kind === "r_shift") {
                depth -= 2;
                if (depth <= 0) {
                    templateEndIndex++;
                    break;
                }
            }
            else if (kind === "semicolon" || kind === "l_brace" || kind === "r_brace" || kind === "r_paren")
                return false;
        }
        if (depth > 0)
            return false;
        index = templateEndIndex;
    }
    const t1 = context.peek(index).kind;
    if (t1 === "identifier")
        return true;
    if ((t1 === "star" || t1 === "amp") && context.peek(index + 1).kind === "identifier")
        return true;
    return false;
}

export function parseArgList(context: ParserInternals): Expression[] {
    const callArguments: Expression[] = [];
    if (context.peek().kind === "r_paren") {
        return callArguments;
    }
    while (!context.eof()) {
        callArguments.push(context.parseExpression());
        if (!context.tryConsume("comma")) {
            break;
        }
    }
    return callArguments;
}
