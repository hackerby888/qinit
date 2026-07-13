import type { TypeSpec } from "../../../ast";
import { isTypeKeyword } from "../../../lexer";
import type { ParserInternals } from "../parser-context";

export function parseTypeSpec(context: ParserInternals): TypeSpec {
    let type = context.parseBaseType();
    // Trailing modifiers: *, &, const
    while (!context.eof()) {
        if (context.tryConsume("star")) {
            type = { kind: "pointer", pointee: type, span: type.span };
        }
        else if (context.peek().kind === "amp" &&
            context.peek(1).kind !== "amp" &&
            context.peek(1).kind !== "eq") {
            // & (but not && or &=)
            context.next();
            type = { kind: "reference", referentType: type, span: type.span };
        }
        else if (context.tryConsumeKw("const")) {
            type = { kind: "const", valueType: type, span: type.span };
        }
        else {
            break;
        }
    }
    return type;
}

export function parseBaseType(context: ParserInternals): TypeSpec {
    const tok = context.peek();
    // const prefix (e.g., "const Type&")
    if (tok.kind === "kw_const") {
        context.next(); // consume const
        const inner = context.parseBaseType();
        return { kind: "const", valueType: inner, span: tok.span };
    }
    // auto — type inferred from the initializer (in qpi.h bodies these are integer counters / pointers)
    if (tok.kind === "kw_auto") {
        context.next();
        return { kind: "name", name: "auto", span: tok.span };
    }
    // `typename` is a parse-time disambiguator (typename Sel<v>::type) — drop it and parse the type that follows; any trailing
    if (tok.kind === "kw_typename") {
        context.next();
        return context.parseBaseType();
    }
    // Built-in type keywords
    if (isTypeKeyword(tok.kind)) {
        return context.parseBuiltinType();
    }
    // struct / enum / class / union prefix
    if (tok.kind === "kw_struct" ||
        tok.kind === "kw_enum" ||
        tok.kind === "kw_class" ||
        tok.kind === "kw_union") {
        context.next();
        const name = context.next().text;
        return { kind: "name", name, span: tok.span };
    }
    // unsigned / signed prefixes
    if (tok.kind === "kw_unsigned" || tok.kind === "kw_signed" || tok.kind === "kw_long") {
        return context.parseBuiltinType();
    }
    // Name or qualified name. In a type position, `Sel<args>::member` is a dependent type — stop the
    const name = context.parseQualifiedName(true);
    if (!name) {
        context.diagnostics.push({
            severity: "error",
            message: `Expected type but got ${tok.kind}`,
            span: tok.span,
        });
        context.next();
        return { kind: "name", name: "int", span: tok.span };
    }
    // Check for template arguments: Name<...>
    if (context.peek().kind === "l_angle") {
        context.next(); // <
        const callArguments: TypeSpec[] = [];
        while (!context.eof() && context.peek().kind !== "r_angle") {
            const kind = context.peek().kind;
            // Non-type arg that is a value expression (literal, paren, sizeof, `-N`, `~N`) — parse at shift precedence so
            if (kind === "int_literal" ||
                kind === "l_paren" ||
                kind === "kw_sizeof" ||
                kind === "char_literal" ||
                kind === "minus" ||
                kind === "tilde" ||
                kind === "kw_true" ||
                kind === "kw_false" ||
                context.templateArgIsExpr()) {
                callArguments.push({ kind: "expr_value", expression: context.parseShift(), span: context.peek().span });
            }
            else if (kind === "d_colon" ||
                kind === "identifier" ||
                isTypeKeyword(kind) ||
                kind === "kw_const" ||
                kind === "kw_struct" ||
                kind === "kw_unsigned" ||
                kind === "kw_signed") {
                callArguments.push(context.parseTypeSpec());
            }
            else {
                const name = context.parseMaybeQualifiedName() || context.next().text;
                callArguments.push({ kind: "name", name, span: context.peek().span });
            }
            if (!context.tryConsume("comma")) {
                break;
            }
        }
        context.consumeAngleClose();
        const inst: TypeSpec = { kind: "template_instance", name, callArguments, span: tok.span };
        // Dependent member type: `Selector<args>::type` — the nested type of a template instance.
        if (context.peek().kind === "d_colon" && context.peek(1).kind === "identifier") {
            context.next(); // ::
            const member = context.next().text;
            return { kind: "dependent_member", base: inst, member, span: tok.span };
        }
        return inst;
    }
    return { kind: "name", name, span: tok.span };
}

export function templateArgIsExpr(context: ParserInternals): boolean {
    if (context.peek().kind !== "identifier")
        return false;
    let index = 1;
    while (context.peek(index).kind === "d_colon" && context.peek(index + 1).kind === "identifier")
        index += 2;
    const operator = context.peek(index).kind;
    if (operator !== "star" &&
        operator !== "plus" &&
        operator !== "slash" &&
        operator !== "percent" &&
        operator !== "l_shift" &&
        operator !== "r_shift")
        return false;
    const after = context.peek(index + 1).kind;
    return after === "identifier" || after === "int_literal" || after === "l_paren";
}

export function parseBuiltinType(context: ParserInternals): TypeSpec {
    // Handle signed/unsigned + char/short/int/long/long long
    const parts: string[] = [];
    while (!context.eof() && isTypeKeyword(context.peek().kind)) {
        parts.push(context.next().text);
    }
    const name = parts.join(" ");
    return { kind: "name", name, span: context.peek().span };
}

export function parseAccessAndType(context: ParserInternals): TypeSpec {
    // public Type / protected Type / private Type
    context.tryConsumeKw("public");
    context.tryConsumeKw("protected");
    context.tryConsumeKw("private");
    context.tryConsumeKw("virtual"); // virtual inheritance — ignore in QPI subset
    return context.parseTypeSpec();
}
