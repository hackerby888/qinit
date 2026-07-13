import type { ClassTemplateDecl, Declaration, EmptyDecl, EnumDecl, EnumeratorDecl, Expression, ExternBlockDecl, FriendDecl, FunctionDecl, StaticAssertDecl, StructDecl, TypedefDeclNode, TypeSpec } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parseEnum(context: ParserInternals): EnumDecl {
    const start = context.next().span; // enum
    let isClass = false;
    // enum class Foo : uint8
    if (context.tryConsume("kw_class")) {
        isClass = true;
    }
    let name: string | undefined;
    if (context.peek().kind === "identifier") {
        name = context.next().text;
    }
    let underlyingType: TypeSpec | undefined;
    if (context.tryConsume("colon")) {
        underlyingType = context.parseTypeSpec();
    }
    const members: EnumeratorDecl[] = [];
    if (context.tryConsume("l_brace")) {
        members.push(...context.parseEnumeratorList());
        context.expect("r_brace", "enum close");
    }
    context.tryConsume("semicolon");
    return {
        kind: "enum",
        name,
        underlyingType,
        isClass,
        members,
        span: context.makeSpan(start),
    };
}

export function parseEnumeratorList(context: ParserInternals): EnumeratorDecl[] {
    const members: EnumeratorDecl[] = [];
    while (!context.eof() && context.peek().kind !== "r_brace") {
        const nameTok = context.expect("identifier", "enumerator name");
        if (!nameTok)
            break;
        let value: Expression | undefined;
        if (context.tryConsume("eq")) {
            value = context.parseExpression();
        }
        members.push({ name: nameTok.text, value, span: nameTok.span });
        if (!context.tryConsume("comma")) {
            break;
        }
    }
    return members;
}

export function parseTypedef(context: ParserInternals): TypedefDeclNode {
    const start = context.next().span; // typedef
    let type = context.parseTypeSpec();
    // Handle function pointer typedefs: typedef RetType (*Name)(Params);
    if (context.peek().kind === "l_paren" && context.peek(1).kind === "star") {
        context.next(); // (
        context.next(); // *
        const nameTok = context.expect("identifier", "typedef function pointer name");
        context.expect("r_paren", "typedef function pointer");
        // Skip parameter list
        if (context.peek().kind === "l_paren") {
            context.skipBalanced("l_paren", "r_paren");
        }
        context.expect("semicolon", "typedef");
        // Return a simplified typedef — the exact signature doesn't matter for our subset
        return {
            kind: "typedef_decl",
            name: nameTok?.text ?? "fn_ptr",
            type: { kind: "pointer", pointee: { kind: "void" } },
            span: context.makeSpan(start),
        };
    }
    const nameTok = context.expect("identifier", "typedef name");
    context.expect("semicolon", "typedef");
    return { kind: "typedef_decl", name: nameTok?.text ?? "", type, span: context.makeSpan(start) };
}

export function parseUsing(context: ParserInternals): Declaration {
    context.next(); // using
    // using namespace QPI;
    if (context.tryConsumeKw("namespace")) {
        const nameTok = context.expect("identifier", "namespace name");
        context.expect("semicolon", "using namespace");
        return {
            kind: "typedef_decl",
            name: `using namespace ${nameTok?.text ?? ""}`,
            type: { kind: "void" },
            span: context.peek().span,
        };
    }
    // using Alias = Type;
    const name = context.parseQualifiedName();
    if (context.tryConsume("eq")) {
        const type = context.parseTypeSpec();
        context.expect("semicolon", "using alias");
        return {
            kind: "typedef_decl",
            name,
            type,
            span: context.peek().span,
        };
    }
    // using Base::member;
    context.expect("semicolon", "using decl");
    return {
        kind: "typedef_decl",
        name,
        type: { kind: "void" },
        span: context.peek().span,
    };
}

export function parseStaticAssertDecl(context: ParserInternals): StaticAssertDecl {
    const start = context.next().span; // static_assert
    context.expect("l_paren", "static_assert");
    const condition = context.parseExpression();
    let message: Expression | undefined;
    if (context.tryConsume("comma")) {
        message = context.parsePrimaryExpression();
    }
    context.expect("r_paren", "static_assert");
    context.expect("semicolon", "static_assert");
    return { kind: "static_assert_decl", condition, message, span: context.makeSpan(start) };
}

export function parseExternBlock(context: ParserInternals): ExternBlockDecl | FunctionDecl {
    const start = context.next().span; // extern
    // extern "C" { ... }
    if (context.peek().kind === "string_literal") {
        const linkage = context.next().text.replace(/"/g, "");
        if (context.tryConsume("l_brace")) {
            const body = context.parseDeclarationList();
            context.expect("r_brace", "extern block");
            return { kind: "extern_block", linkage, body, span: context.makeSpan(start) };
        }
        // extern "C" function declaration
        const func = context.parseFunctionAfterReturnType({ kind: "name", name: "void" }, true);
        return func;
    }
    // extern function
    const func = context.parseFunctionAfterReturnType({ kind: "name", name: "void" }, true);
    return func;
}

export function parseFriend(context: ParserInternals): FriendDecl {
    const start = context.next().span; // friend
    const declaration = context.parseDeclaration();
    if (!declaration) {
        return {
            kind: "friend",
            declaration: {
                kind: "function",
                name: "",
                returnType: { kind: "void" },
                params: [],
                isConstexpr: false,
                isStatic: false,
                isInline: false,
                isExternC: false,
                isVirtual: false,
                isOverride: false,
                isDeleted: false,
                isDefault: false,
                span: start,
            },
            span: start,
        };
    }
    return {
        kind: "friend",
        declaration: declaration as FunctionDecl | StructDecl | ClassTemplateDecl,
        span: context.makeSpan(start),
    };
}

export function parseAccessSpec(context: ParserInternals): EmptyDecl {
    context.next(); // public/protected/private
    context.expect("colon", "access specifier");
    return { kind: "empty" };
}
