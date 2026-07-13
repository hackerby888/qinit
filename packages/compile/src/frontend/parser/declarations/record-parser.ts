import type { ClassTemplateDecl, Declaration, NamespaceDecl, StructDecl, TypeSpec } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parseNamespace(context: ParserInternals): NamespaceDecl {
    const start = context.next().span; // namespace
    const nameTok = context.expect("identifier", "namespace name");
    const name = nameTok?.text ?? "";
    let body: Declaration[] = [];
    if (context.tryConsume("l_brace")) {
        body = context.parseDeclarationList();
        context.expect("r_brace", "namespace close");
    }
    return {
        kind: "namespace",
        name,
        body,
        span: context.makeSpan(start),
    };
}

export function parseStruct(context: ParserInternals): StructDecl {
    const start = context.next().span; // struct
    const nameTok = context.expect("identifier", "struct name");
    const name = nameTok?.text ?? "";
    // Partial / explicit specialization: `struct Foo<ProposalDataYesNo, numOfVotes> : ... { ... }`.
    let specializationArgs: TypeSpec[] | undefined;
    if (context.peek().kind === "l_angle") {
        specializationArgs = context.parseSpecializationArgs();
    }
    const bases: TypeSpec[] = [];
    // Check for inheritance: struct Foo : public Base
    if (context.tryConsume("colon")) {
        bases.push(context.parseAccessAndType());
        while (context.tryConsume("comma")) {
            bases.push(context.parseAccessAndType());
        }
    }
    const members: Declaration[] = [];
    let hadBody = false;
    if (context.tryConsume("l_brace")) {
        hadBody = true;
        members.push(...context.parseClassMembers());
        context.expect("r_brace", "struct close");
    }
    const struct: StructDecl = {
        kind: "struct",
        name,
        bases,
        members,
        specializationArgs,
        span: context.makeSpan(start),
    };
    // Combined form: `struct Tag {...} field[N], field2;` — declarators after the body become member variables whose type is
    if (hadBody && context.declaratorFollows()) {
        const declType: TypeSpec = { kind: "inline_struct", struct, span: start };
        while (context.peek().kind === "star" || context.peek().kind === "amp")
            context.next();
        const first = context.expect("identifier", "struct declarator")?.text ?? "";
        const vars = context.parseDeclaratorList(declType, first, false, false);
        for (const varValue of vars)
            context.pending.push(varValue);
    }
    else {
        context.tryConsume("semicolon");
    }
    return struct;
}

export function declaratorFollows(context: ParserInternals): boolean {
    const kind = context.peek().kind;
    return kind === "identifier" || kind === "star" || kind === "amp" || kind === "l_bracket";
}

export function parseSpecializationArgs(context: ParserInternals): TypeSpec[] {
    context.next(); // <
    const callArguments: TypeSpec[] = [];
    while (!context.eof() && context.peek().kind !== "r_angle") {
        const kind = context.peek().kind;
        if (kind === "int_literal" ||
            kind === "l_paren" ||
            kind === "kw_sizeof" ||
            kind === "char_literal" ||
            kind === "minus" ||
            kind === "tilde" ||
            kind === "kw_true" ||
            kind === "kw_false") {
            callArguments.push({ kind: "expr_value", expression: context.parseShift(), span: context.peek().span });
        }
        else {
            callArguments.push(context.parseTypeSpec());
        }
        if (!context.tryConsume("comma"))
            break;
    }
    context.consumeAngleClose();
    return callArguments;
}

export function parseUnion(context: ParserInternals): StructDecl {
    const start = context.next().span; // union
    let name = "";
    // Union may be anonymous
    if (context.peek().kind === "identifier") {
        name = context.next().text;
    }
    const members: Declaration[] = [];
    let hadBody = false;
    if (context.tryConsume("l_brace")) {
        hadBody = true;
        members.push(...context.parseClassMembers());
        context.expect("r_brace", "union close");
    }
    const union: StructDecl = {
        kind: "struct",
        name,
        bases: [],
        members,
        isUnion: true,
        span: context.makeSpan(start),
    };
    // Combined form: `union Data {...} data;` — the declarator after the body is a member variable of this
    if (hadBody && context.declaratorFollows()) {
        const declType: TypeSpec = { kind: "inline_struct", struct: union, span: start };
        while (context.peek().kind === "star" || context.peek().kind === "amp")
            context.next();
        const first = context.expect("identifier", "union declarator")?.text ?? "";
        const vars = context.parseDeclaratorList(declType, first, false, false);
        for (const varValue of vars)
            context.pending.push(varValue);
    }
    else {
        context.tryConsume("semicolon");
    }
    return union;
}

export function parseClassOrTemplate(context: ParserInternals): StructDecl | ClassTemplateDecl {
    // "class" keyword — could be a plain class or a template
    return context.parseStruct(); // In QPI subset, class ≡ struct
}
