import type { Declaration, EmptyDecl } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parseDeclaration(context: ParserInternals): Declaration | null {
    const tok = context.peek();
    switch (tok.kind) {
        case "kw_namespace":
            return context.parseNamespace();
        case "kw_struct":
            return context.parseStruct();
        case "kw_class":
            return context.parseClassOrTemplate();
        case "kw_template":
            return context.parseTemplateDeclaration();
        case "kw_enum":
            return context.parseEnum();
        case "kw_typedef":
            return context.parseTypedef();
        case "kw_using":
            return context.parseUsing();
        case "kw_static_assert":
            return context.parseStaticAssertDecl();
        case "kw_extern":
            return context.parseExternBlock();
        case "kw_friend":
            return context.parseFriend();
        case "kw_public":
        case "kw_protected":
        case "kw_private":
            return context.parseAccessSpec();
        case "kw_constexpr":
        case "kw_static":
        case "kw_inline":
        case "kw_virtual":
            return context.parseFunctionOrVariable(); // with modifiers
        case "kw_const":
            // `const Type& name = ...` — a const qualifier belongs to the type, so peek the whole type
            return context.parseFunctionOrVariablePeekType();
        case "hash":
            return context.parsePreprocessorLine();
        case "kw_signed":
        case "kw_unsigned":
        case "kw_void":
        case "kw_bool":
        case "kw_char":
        case "kw_short":
        case "kw_int":
        case "kw_long":
        case "kw_double":
        case "kw_float":
        case "kw_auto":
        // collapsed multi-word builtin types (the lexer merges `unsigned int` → kw_unsigned_int etc.)
        case "kw_signed_char":
        case "kw_unsigned_char":
        case "kw_signed_short":
        case "kw_unsigned_short":
        case "kw_signed_int":
        case "kw_unsigned_int":
        case "kw_signed_long_long":
        case "kw_unsigned_long_long":
        case "kw_long_long":
            // Type keyword at top level → likely a variable declaration (or free function)
            return context.parseFunctionOrVariablePeekType();
        case "identifier":
            // Could be: function definition, variable declaration, or constructor
            return context.parseIdentifierDeclaration();
        case "semicolon":
            context.next(); // empty declaration
            return { kind: "empty", span: tok.span } as EmptyDecl;
        case "kw_union":
            return context.parseUnion();
        case "kw_operator": {
            // Conversion operator: `operator Type() const { ... }` — no leading return type. Parsed as a
            context.next();
            const targetType = context.parseTypeSpec();
            const targetName = targetType.kind === "name" ? targetType.name : "?";
            return context.parseFunctionRest(`operator ${targetName}`, targetType, false, false, false, false, false);
        }
        default:
            // Skip unknown token — qpi.h has constructs our subset parser doesn't handle. Recorded as a
            context.bodyDiagnostics.push({
                severity: "warning",
                category: "fidelity",
                message: `skipped unparseable token '${tok.text}' (${tok.kind})`,
                span: tok.span,
            });
            context.next();
            return { kind: "empty", span: tok.span } as EmptyDecl;
    }
}

export function parsePreprocessorLine(context: ParserInternals): Declaration {
    // Skip # line directive remnants
    context.next();
    while (!context.eof() && context.peek().kind !== "eof" && context.peek().text !== "\n") {
        context.next();
    }
    return { kind: "empty" };
}

export function parseDeclarationList(context: ParserInternals): Declaration[] {
    const declarations: Declaration[] = [];
    while (!context.eof() && context.peek().kind !== "r_brace") {
        const before = (context.lex as any).index;
        const errsBefore = context.diagnostics.length;
        const declaration = context.parseDeclaration();
        if (declaration && declaration.kind !== "empty")
            declarations.push(declaration);
        while (context.pending.length)
            declarations.push(context.pending.shift()!);
        context.recover(before, errsBefore);
    }
    return declarations;
}

export function parseClassMembers(context: ParserInternals): Declaration[] {
    const members: Declaration[] = [];
    while (!context.eof() && context.peek().kind !== "r_brace") {
        const tok = context.peek();
        if (tok.kind === "kw_public" || tok.kind === "kw_protected" || tok.kind === "kw_private") {
            context.next();
            context.expect("colon", "access spec");
            continue;
        }
        if (tok.kind === "kw_friend") {
            const field = context.parseFriend();
            members.push(field);
            continue;
        }
        const before = (context.lex as any).index;
        const errsBefore = context.diagnostics.length;
        const declaration = context.parseDeclaration();
        if (declaration && declaration.kind !== "empty")
            members.push(declaration);
        while (context.pending.length)
            members.push(context.pending.shift()!);
        context.recover(before, errsBefore);
    }
    return members;
}
