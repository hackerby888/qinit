import type { Declaration, Expression, FunctionDecl, ParamDecl, Statement, TypeSpec, VariableDecl } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parseFunctionOrVariable(context: ParserInternals): Declaration {
    let isConstexpr = false;
    let isStatic = false;
    let isInline = false;
    let isVirtual = false;
    let isExtern = false;
    // Consume modifiers
    while (!context.eof()) {
        if (context.tryConsumeKw("constexpr")) {
            isConstexpr = true;
        }
        else if (context.tryConsumeKw("static")) {
            isStatic = true;
        }
        else if (context.tryConsumeKw("inline")) {
            isInline = true;
        }
        else if (context.tryConsumeKw("virtual")) {
            isVirtual = true;
        }
        else if (context.tryConsumeKw("extern")) {
            isExtern = true;
        }
        else {
            break;
        }
    }
    return context.parseAfterModifiers(isConstexpr, isStatic, isInline, isVirtual, isExtern);
}

export function parseFunctionOrVariablePeekType(context: ParserInternals): Declaration {
    return context.parseAfterModifiers(false, false, false, false, false);
}

export function parseIdentifierDeclaration(context: ParserInternals): Declaration {
    // Identifier at top level — peek ahead
    const tok = context.peek();
    const nextTok = context.peek(1);
    // Identifier followed by "::" → qualified name (function/variable)
    if (nextTok.kind === "d_colon") {
        return context.parseAfterModifiers(false, false, false, false, false);
    }
    // Identifier followed by "(" → function definition
    if (nextTok.kind === "l_paren") {
        return context.parseAfterModifiers(false, false, false, false, false);
    }
    // Identifier followed by ";" → variable declaration Identifier followed by "=" → variable with init
    if (nextTok.kind === "semicolon" || nextTok.kind === "eq") {
        return context.parseAfterModifiers(false, false, false, false, false);
    }
    // Assume variable declaration
    return context.parseAfterModifiers(false, false, false, false, false);
}

export function parseAfterModifiers(context: ParserInternals, isConstexpr: boolean, isStatic: boolean, isInline: boolean, isVirtual: boolean, isExtern: boolean): Declaration {
    // Parse return type (or variable type)
    const type = context.parseTypeSpec();
    // Check for function call syntax: Type(...) or Type::name(
    const name = context.parseMaybeQualifiedName();
    if (!name) {
        // Constructor / destructor: `ClassName(...) {...}` or `~ClassName() {...}` — no return type. Parse
        if (context.peek().kind === "l_paren" && type.kind === "name") {
            return context.parseFunctionRest(type.name, { kind: "void" }, isConstexpr, isStatic, isInline, isVirtual, isExtern);
        }
        // Just a type with no name — semicolon
        context.expect("semicolon", "declaration");
        return { kind: "empty" };
    }
    // `name(...)` is either a function declaration or a variable with constructor-style direct-init (Type name(expr, ...);). In this subset
    if (context.peek().kind === "l_paren") {
        if (context.looksLikeDirectInit()) {
            return context.parseDirectInitVar(name, type, isConstexpr, isStatic);
        }
        return context.parseFunctionRest(name, type, isConstexpr, isStatic, isInline, isVirtual, isExtern);
    }
    // Variable: name; or name = init;
    return context.parseVariableRest(name, type, isConstexpr, isStatic);
}

export function looksLikeDirectInit(context: ParserInternals): boolean {
    const after = context.peek(1).kind;
    return (after === "kw_sizeof" ||
        after === "int_literal" ||
        after === "float_literal" ||
        after === "string_literal" ||
        after === "char_literal" ||
        after === "kw_true" ||
        after === "kw_false" ||
        after === "kw_nullptr" ||
        after === "minus" ||
        // A `{` after `(` is a braced-init constructor argument (`AssetPossessionIterator iter({NULL_ID, name})`) a parameter list can't open with
        after === "bang" ||
        after === "tilde" ||
        after === "l_brace");
}

export function parseDirectInitVar(context: ParserInternals, name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): VariableDecl {
    const start = context.peek().span;
    context.expect("l_paren", "ctor args");
    const callArguments: Expression[] = [];
    if (context.peek().kind !== "r_paren") {
        callArguments.push(context.parseExpression());
        while (context.tryConsume("comma")) {
            callArguments.push(context.parseExpression());
        }
    }
    context.expect("r_paren", "ctor args close");
    context.expect("semicolon", "direct-init declaration");
    return {
        kind: "variable",
        name,
        type,
        initializer: { kind: "construct", type, callArguments, span: start },
        isConstexpr,
        isStatic,
        isExtern: false,
        isMember: false,
        access: "public",
        span: context.makeSpan(start),
    };
}

export function parseFunctionAfterReturnType(context: ParserInternals, retType: TypeSpec, isExternC: boolean): FunctionDecl {
    const name = context.parseMaybeQualifiedName() ?? "";
    const isConstexpr = false;
    return context.parseFunctionRest(name, retType, isConstexpr, false, false, false, isExternC);
}

export function parseFunctionRest(context: ParserInternals, name: string, retType: TypeSpec, isConstexpr: boolean, isStatic: boolean, isInline: boolean, isVirtual: boolean, isExternC: boolean): FunctionDecl {
    const start = context.peek(-1)?.span || context.peek().span;
    // Function parameters
    context.expect("l_paren", "function params");
    const params = context.parseFunctionParams();
    context.expect("r_paren", "function params close");
    // Optional const qualifier
    context.tryConsumeKw("const");
    // Optional override/final/noexcept
    const isOverride = !!context.tryConsumeKw("override");
    context.tryConsumeKw("final");
    context.tryConsumeKw("noexcept");
    let body: Statement | undefined;
    let isDeleted = false;
    let isDefault = false;
    if (context.tryConsume("eq")) {
        if (context.tryConsumeKw("delete")) {
            isDeleted = true;
        }
        else if (context.tryConsumeKw("default")) {
            isDefault = true;
        }
        context.expect("semicolon", "function = delete/default");
    }
    else if (context.peek().kind === "l_brace") {
        body = context.parseFunctionBody();
    }
    else {
        context.expect("semicolon", "function declaration");
    }
    return {
        kind: "function",
        name,
        returnType: retType,
        params,
        body,
        isConstexpr,
        isStatic,
        isInline,
        isExternC,
        isVirtual,
        isOverride,
        isDeleted,
        isDefault,
        span: context.makeSpan(start),
    };
}

export function parseVariableRest(context: ParserInternals, name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): Declaration {
    const vars = context.parseDeclaratorList(type, name, isConstexpr, isStatic);
    // First declarator is returned; the rest are queued for the enclosing member/decl loop.
    for (let varIndex = 1; varIndex < vars.length; varIndex++)
        context.pending.push(vars[varIndex]);
    return vars[0] ?? { kind: "empty" };
}

export function parseDeclaratorList(context: ParserInternals, baseType: TypeSpec, firstName: string, isConstexpr: boolean, isStatic: boolean): VariableDecl[] {
    const out: VariableDecl[] = [];
    let name = firstName;
    while (true) {
        const start = context.peek().span;
        let type = baseType;
        // Array dimensions: name[E][E2]... — innermost dimension binds tightest, so collect then nest.
        const dims: Expression[] = [];
        while (context.peek().kind === "l_bracket") {
            context.next(); // [
            if (context.peek().kind === "r_bracket") {
                dims.push({ kind: "int_literal", value: "0", span: context.peek().span });
            }
            else {
                dims.push(context.parseExpression());
            }
            context.expect("r_bracket", "array dimension");
        }
        for (let index = dims.length - 1; index >= 0; index--) {
            type = { kind: "array", element: type, size: dims[index], span: start };
        }
        let initializer: Expression | undefined;
        if (context.tryConsume("eq")) {
            initializer = context.parseExpression();
        }
        else if (context.peek().kind === "l_brace") {
            // Direct-list initialization is executable semantics, not layout trivia. Preserve the
            const list = context.parseExpression();
            initializer =
                type.kind === "array" || list.kind !== "initializer_list"
                    ? list
                    : { kind: "construct", type, callArguments: list.expressions, span: list.span };
        }
        out.push({
            kind: "variable",
            name,
            type,
            initializer,
            isConstexpr,
            isStatic,
            isExtern: false,
            isMember: false,
            access: "public",
            span: context.makeSpan(start),
        });
        if (context.tryConsume("comma")) {
            // next declarator: optional * / & then a name
            while (context.peek().kind === "star" || context.peek().kind === "amp")
                context.next();
            const token = context.peek();
            if (token.kind === "identifier") {
                name = context.next().text;
                continue;
            }
        }
        break;
    }
    context.expect("semicolon", "variable");
    return out;
}

export function parseFunctionParams(context: ParserInternals): ParamDecl[] {
    const params: ParamDecl[] = [];
    if (context.peek().kind === "r_paren") {
        return params;
    }
    if (context.peek().kind === "kw_void" && context.peek(1).kind === "r_paren") {
        context.next(); // void
        return params;
    }
    while (!context.eof() && context.peek().kind !== "r_paren") {
        let type = context.parseTypeSpec();
        let name = "";
        // Function-pointer parameter: `void (*callback)(Args...)` or the unnamed `void (*)(Args...)`
        // used by core's oracle wrappers. The pointee signature is not called by generated Wasm, but the
        // parameter remains an address in the parsed ABI and still counts for overload resolution.
        if (context.peek().kind === "l_paren" && context.peek(1).kind === "star") {
            context.next();
            context.next();
            if (context.peek().kind === "identifier")
                name = context.next().text;
            context.expect("r_paren", "function-pointer declarator");
            context.expect("l_paren", "function-pointer parameters");
            let depth = 1;
            while (!context.eof() && depth > 0) {
                const token = context.next();
                if (token.kind === "l_paren")
                    depth++;
                else if (token.kind === "r_paren")
                    depth--;
            }
            type = { kind: "pointer", pointee: type, span: type.span };
        }
        if (!name && context.peek().kind === "identifier") {
            name = context.next().text;
        }
        let defaultVal: Expression | undefined;
        if (context.tryConsume("eq")) {
            defaultVal = context.parseExpression();
        }
        params.push({ name, type, defaultValue: defaultVal, span: context.peek().span });
        if (!context.tryConsume("comma")) {
            break;
        }
    }
    return params;
}
