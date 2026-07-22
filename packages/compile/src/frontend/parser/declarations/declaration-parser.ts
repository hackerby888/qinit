import type {
    ClassTemplateDecl,
    Declaration,
    EmptyDecl,
    EnumDecl,
    EnumeratorDecl,
    Expression,
    ExternBlockDecl,
    FriendDecl,
    FunctionDecl,
    NamespaceDecl,
    StaticAssertDecl,
    StructDecl,
    TranslationUnit,
    TypedefDeclNode,
    TypeSpec,
} from "../../../ast";
import type { Parser } from "../parser";

export class DeclarationParser {
    constructor(private readonly parser: Parser) {}

    parseDeclaration(): Declaration | null {
        const tok = this.parser.state.peek();
        switch (tok.kind) {
            case "kw_namespace":
                return this.parser.records.parseNamespace();
            case "kw_struct":
                return this.parser.records.parseStruct();
            case "kw_class":
                return this.parser.records.parseClassOrTemplate();
            case "kw_template":
                return this.parser.templates.parseTemplateDeclaration();
            case "kw_enum":
                return this.parser.declarations.parseEnum();
            case "kw_typedef":
                return this.parser.declarations.parseTypedef();
            case "kw_using":
                return this.parser.declarations.parseUsing();
            case "kw_static_assert":
                return this.parser.declarations.parseStaticAssertDecl();
            case "kw_extern":
                return this.parser.declarations.parseExternBlock();
            case "kw_friend":
                return this.parser.declarations.parseFriend();
            case "kw_public":
            case "kw_protected":
            case "kw_private":
                return this.parser.declarations.parseAccessSpec();
            case "kw_constexpr":
            case "kw_static":
            case "kw_inline":
            case "kw_virtual":
                return this.parser.functions.parseFunctionOrVariable(); // with modifiers
            case "kw_const":
                // `const Type& name = ...` — a const qualifier belongs to the type, so peek the whole type
                return this.parser.functions.parseFunctionOrVariablePeekType();
            case "hash":
                return this.parser.declarations.parsePreprocessorLine();
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
                return this.parser.functions.parseFunctionOrVariablePeekType();
            case "identifier":
                // Could be: function definition, variable declaration, or constructor
                return this.parser.functions.parseIdentifierDeclaration();
            case "semicolon":
                this.parser.state.next(); // empty declaration
                return { kind: "empty", span: tok.span } as EmptyDecl;
            case "kw_union":
                return this.parser.records.parseUnion();
            case "kw_operator": {
                // Conversion operators use their target as the return type.
                this.parser.state.next();
                const targetType = this.parser.types.parseTypeSpec();
                const targetName = targetType.kind === "name" ? targetType.name : "?";
                return this.parser.functions.parseFunctionRest(`operator ${targetName}`, targetType, false, false, false, false, false);
            }
            default:
                // Record unsupported qpi.h constructs as fidelity warnings.
                this.parser.state.bodyDiagnostics.push({
                    severity: "warning",
                    category: "fidelity",
                    message: `skipped unparseable token '${tok.text}' (${tok.kind})`,
                    span: tok.span,
                });
                this.parser.state.next();
                return { kind: "empty", span: tok.span } as EmptyDecl;
        }
    }

    parsePreprocessorLine(): Declaration {
        // Skip # line directive remnants
        this.parser.state.next();
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "eof" && this.parser.state.peek().text !== "\n") {
            this.parser.state.next();
        }
        return { kind: "empty" };
    }

    parseDeclarationList(): Declaration[] {
        const declarations: Declaration[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
            const before = this.parser.state.position;
            const errsBefore = this.parser.state.diagnostics.length;
            const declaration = this.parser.declarations.parseDeclaration();
            if (declaration && declaration.kind !== "empty")
                declarations.push(declaration);
            while (this.parser.state.pendingDeclarations.length)
                declarations.push(this.parser.state.pendingDeclarations.shift()!);
            this.parser.recovery.recover(before, errsBefore);
        }
        return declarations;
    }

    parseClassMembers(): Declaration[] {
        const members: Declaration[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
            const tok = this.parser.state.peek();
            if (tok.kind === "kw_public" || tok.kind === "kw_protected" || tok.kind === "kw_private") {
                this.parser.state.next();
                this.parser.state.expect("colon", "access spec");
                continue;
            }
            if (tok.kind === "kw_friend") {
                const field = this.parser.declarations.parseFriend();
                members.push(field);
                continue;
            }
            const before = this.parser.state.position;
            const errsBefore = this.parser.state.diagnostics.length;
            const declaration = this.parser.declarations.parseDeclaration();
            if (declaration && declaration.kind !== "empty")
                members.push(declaration);
            while (this.parser.state.pendingDeclarations.length)
                members.push(this.parser.state.pendingDeclarations.shift()!);
            this.parser.recovery.recover(before, errsBefore);
        }
        return members;
    }

    parseEnum(): EnumDecl {
        const start = this.parser.state.next().span; // enum
        let isClass = false;
        // enum class Foo : uint8
        if (this.parser.state.tryConsume("kw_class")) {
            isClass = true;
        }
        let name: string | undefined;
        if (this.parser.state.peek().kind === "identifier") {
            name = this.parser.state.next().text;
        }
        let underlyingType: TypeSpec | undefined;
        if (this.parser.state.tryConsume("colon")) {
            underlyingType = this.parser.types.parseTypeSpec();
        }
        const members: EnumeratorDecl[] = [];
        if (this.parser.state.tryConsume("l_brace")) {
            members.push(...this.parser.declarations.parseEnumeratorList());
            this.parser.state.expect("r_brace", "enum close");
        }
        this.parser.state.tryConsume("semicolon");
        return {
            kind: "enum",
            name,
            underlyingType,
            isClass,
            members,
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseEnumeratorList(): EnumeratorDecl[] {
        const members: EnumeratorDecl[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
            const nameTok = this.parser.state.expect("identifier", "enumerator name");
            if (!nameTok)
                break;
            let value: Expression | undefined;
            if (this.parser.state.tryConsume("eq")) {
                value = this.parser.expressions.parseExpression();
            }
            members.push({ name: nameTok.text, value, span: nameTok.span });
            if (!this.parser.state.tryConsume("comma")) {
                break;
            }
        }
        return members;
    }

    parseTypedef(): TypedefDeclNode {
        const start = this.parser.state.next().span; // typedef
        let type = this.parser.types.parseTypeSpec();
        // Handle function pointer typedefs: typedef RetType (*Name)(Params);
        if (this.parser.state.peek().kind === "l_paren" && this.parser.state.peek(1).kind === "star") {
            this.parser.state.next(); // (
            this.parser.state.next(); // *
            const nameTok = this.parser.state.expect("identifier", "typedef function pointer name");
            this.parser.state.expect("r_paren", "typedef function pointer");
            // Skip parameter list
            if (this.parser.state.peek().kind === "l_paren") {
                this.parser.recovery.skipBalanced("l_paren", "r_paren");
            }
            this.parser.state.expect("semicolon", "typedef");
            // Return a simplified typedef — the exact signature doesn't matter for our subset
            return {
                kind: "typedef_decl",
                name: nameTok?.text ?? "fn_ptr",
                type: { kind: "pointer", pointee: { kind: "void" } },
                span: this.parser.recovery.makeSpan(start),
            };
        }
        const nameTok = this.parser.state.expect("identifier", "typedef name");
        this.parser.state.expect("semicolon", "typedef");
        return { kind: "typedef_decl", name: nameTok?.text ?? "", type, span: this.parser.recovery.makeSpan(start) };
    }

    parseUsing(): Declaration {
        this.parser.state.next(); // using
        // using namespace QPI;
        if (this.parser.state.tryConsumeKeyword("namespace")) {
            const nameTok = this.parser.state.expect("identifier", "namespace name");
            this.parser.state.expect("semicolon", "using namespace");
            return {
                kind: "typedef_decl",
                name: `using namespace ${nameTok?.text ?? ""}`,
                type: { kind: "void" },
                span: this.parser.state.peek().span,
            };
        }
        // using Alias = Type;
        const name = this.parser.types.parseQualifiedName();
        if (this.parser.state.tryConsume("eq")) {
            const type = this.parser.types.parseTypeSpec();
            this.parser.state.expect("semicolon", "using alias");
            return {
                kind: "typedef_decl",
                name,
                type,
                span: this.parser.state.peek().span,
            };
        }
        // using Base::member;
        this.parser.state.expect("semicolon", "using decl");
        return {
            kind: "typedef_decl",
            name,
            type: { kind: "void" },
            span: this.parser.state.peek().span,
        };
    }

    parseStaticAssertDecl(): StaticAssertDecl {
        const start = this.parser.state.next().span; // static_assert
        this.parser.state.expect("l_paren", "static_assert");
        const condition = this.parser.expressions.parseExpression();
        let message: Expression | undefined;
        if (this.parser.state.tryConsume("comma")) {
            message = this.parser.expressions.parsePrimaryExpression();
        }
        this.parser.state.expect("r_paren", "static_assert");
        this.parser.state.expect("semicolon", "static_assert");
        return { kind: "static_assert_decl", condition, message, span: this.parser.recovery.makeSpan(start) };
    }

    parseExternBlock(): ExternBlockDecl | FunctionDecl {
        const start = this.parser.state.next().span; // extern
        // extern "C" { ... }
        if (this.parser.state.peek().kind === "string_literal") {
            const linkage = this.parser.state.next().text.replace(/"/g, "");
            if (this.parser.state.tryConsume("l_brace")) {
                const body = this.parser.declarations.parseDeclarationList();
                this.parser.state.expect("r_brace", "extern block");
                return { kind: "extern_block", linkage, body, span: this.parser.recovery.makeSpan(start) };
            }
            // extern "C" function declaration
            const func = this.parser.functions.parseFunctionAfterReturnType({ kind: "name", name: "void" }, true);
            return func;
        }
        // extern function
        const func = this.parser.functions.parseFunctionAfterReturnType({ kind: "name", name: "void" }, true);
        return func;
    }

    parseFriend(): FriendDecl {
        const start = this.parser.state.next().span; // friend
        const declaration = this.parser.declarations.parseDeclaration();
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
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseAccessSpec(): EmptyDecl {
        this.parser.state.next(); // public/protected/private
        this.parser.state.expect("colon", "access specifier");
        return { kind: "empty" };
    }
}
