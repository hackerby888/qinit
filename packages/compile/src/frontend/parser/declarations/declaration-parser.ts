import {
    AstKind,
    DiagnosticCategory,
    DiagnosticSeverity,
    TokenKind,
} from "../../../enums";
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
            case TokenKind.KW_NAMESPACE:
                return this.parser.records.parseNamespace();
            case TokenKind.KW_STRUCT:
                return this.parser.records.parseStruct();
            case TokenKind.KW_CLASS:
                return this.parser.records.parseClassOrTemplate();
            case TokenKind.KW_TEMPLATE:
                return this.parser.templates.parseTemplateDeclaration();
            case TokenKind.KW_ENUM:
                return this.parser.declarations.parseEnum();
            case TokenKind.KW_TYPEDEF:
                return this.parser.declarations.parseTypedef();
            case TokenKind.KW_USING:
                return this.parser.declarations.parseUsing();
            case TokenKind.KW_STATIC_ASSERT:
                return this.parser.declarations.parseStaticAssertDecl();
            case TokenKind.KW_EXTERN:
                return this.parser.declarations.parseExternBlock();
            case TokenKind.KW_FRIEND:
                return this.parser.declarations.parseFriend();
            case TokenKind.KW_PUBLIC:
            case TokenKind.KW_PROTECTED:
            case TokenKind.KW_PRIVATE:
                return this.parser.declarations.parseAccessSpec();
            case TokenKind.KW_CONSTEXPR:
            case TokenKind.KW_STATIC:
            case TokenKind.KW_INLINE:
            case TokenKind.KW_VIRTUAL:
                return this.parser.functions.parseFunctionOrVariable(); // with modifiers
            case TokenKind.KW_CONST:
                // `const Type& name = ...` — a const qualifier belongs to the type, so peek the whole type
                return this.parser.functions.parseFunctionOrVariablePeekType();
            case TokenKind.HASH:
                return this.parser.declarations.parsePreprocessorLine();
            case TokenKind.KW_SIGNED:
            case TokenKind.KW_UNSIGNED:
            case TokenKind.KW_VOID:
            case TokenKind.KW_BOOL:
            case TokenKind.KW_CHAR:
            case TokenKind.KW_SHORT:
            case TokenKind.KW_INT:
            case TokenKind.KW_LONG:
            case TokenKind.KW_DOUBLE:
            case TokenKind.KW_FLOAT:
            case TokenKind.KW_AUTO:
            // collapsed multi-word builtin types (the lexer merges `unsigned int` → kw_unsigned_int etc.)
            case TokenKind.KW_SIGNED_CHAR:
            case TokenKind.KW_UNSIGNED_CHAR:
            case TokenKind.KW_SIGNED_SHORT:
            case TokenKind.KW_UNSIGNED_SHORT:
            case TokenKind.KW_SIGNED_INT:
            case TokenKind.KW_UNSIGNED_INT:
            case TokenKind.KW_SIGNED_LONG_LONG:
            case TokenKind.KW_UNSIGNED_LONG_LONG:
            case TokenKind.KW_LONG_LONG:
                // Type keyword at top level → likely a variable declaration (or free function)
                return this.parser.functions.parseFunctionOrVariablePeekType();
            case TokenKind.IDENTIFIER:
                // Could be: function definition, variable declaration, or constructor
                return this.parser.functions.parseIdentifierDeclaration();
            case TokenKind.SEMICOLON:
                this.parser.state.next(); // empty declaration
                return { kind: AstKind.EMPTY, span: tok.span } as EmptyDecl;
            case TokenKind.KW_UNION:
                return this.parser.records.parseUnion();
            case TokenKind.KW_OPERATOR: {
                // Conversion operators use their target as the return type.
                this.parser.state.next();
                const targetType = this.parser.types.parseTypeSpec();
                const targetName = targetType.kind === AstKind.NAME ? targetType.name : "?";
                return this.parser.functions.parseFunctionRest(`operator ${targetName}`, targetType, false, false, false, false, false);
            }
            default:
                // Record unsupported qpi.h constructs as fidelity warnings.
                this.parser.state.bodyDiagnostics.push({
                    severity: DiagnosticSeverity.WARNING,
                    category: DiagnosticCategory.FIDELITY,
                    message: `skipped unparseable token '${tok.text}' (${tok.kind})`,
                    span: tok.span,
                });
                this.parser.state.next();
                return { kind: AstKind.EMPTY, span: tok.span } as EmptyDecl;
        }
    }

    parsePreprocessorLine(): Declaration {
        // Skip # line directive remnants
        this.parser.state.next();
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.EOF && this.parser.state.peek().text !== "\n") {
            this.parser.state.next();
        }
        return { kind: AstKind.EMPTY };
    }

    parseDeclarationList(): Declaration[] {
        const declarations: Declaration[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
            const before = this.parser.state.position;
            const errsBefore = this.parser.state.diagnostics.length;
            const declaration = this.parser.declarations.parseDeclaration();
            if (declaration && declaration.kind !== AstKind.EMPTY)
                declarations.push(declaration);
            while (this.parser.state.pendingDeclarations.length)
                declarations.push(this.parser.state.pendingDeclarations.shift()!);
            this.parser.recovery.recover(before, errsBefore);
        }
        return declarations;
    }

    parseClassMembers(): Declaration[] {
        const members: Declaration[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
            const tok = this.parser.state.peek();
            if (tok.kind === TokenKind.KW_PUBLIC || tok.kind === TokenKind.KW_PROTECTED || tok.kind === TokenKind.KW_PRIVATE) {
                this.parser.state.next();
                this.parser.state.expect(TokenKind.COLON, "access spec");
                continue;
            }
            if (tok.kind === TokenKind.KW_FRIEND) {
                const field = this.parser.declarations.parseFriend();
                members.push(field);
                continue;
            }
            const before = this.parser.state.position;
            const errsBefore = this.parser.state.diagnostics.length;
            const declaration = this.parser.declarations.parseDeclaration();
            if (declaration && declaration.kind !== AstKind.EMPTY)
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
        if (this.parser.state.tryConsume(TokenKind.KW_CLASS)) {
            isClass = true;
        }
        let name: string | undefined;
        if (this.parser.state.peek().kind === TokenKind.IDENTIFIER) {
            name = this.parser.state.next().text;
        }
        let underlyingType: TypeSpec | undefined;
        if (this.parser.state.tryConsume(TokenKind.COLON)) {
            underlyingType = this.parser.types.parseTypeSpec();
        }
        const members: EnumeratorDecl[] = [];
        if (this.parser.state.tryConsume(TokenKind.L_BRACE)) {
            members.push(...this.parser.declarations.parseEnumeratorList());
            this.parser.state.expect(TokenKind.R_BRACE, "enum close");
        }
        this.parser.state.tryConsume(TokenKind.SEMICOLON);
        return {
            kind: AstKind.ENUM,
            name,
            underlyingType,
            isClass,
            members,
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseEnumeratorList(): EnumeratorDecl[] {
        const members: EnumeratorDecl[] = [];
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
            const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "enumerator name");
            if (!nameTok)
                break;
            let value: Expression | undefined;
            if (this.parser.state.tryConsume(TokenKind.EQ)) {
                value = this.parser.expressions.parseExpression();
            }
            members.push({ name: nameTok.text, value, span: nameTok.span });
            if (!this.parser.state.tryConsume(TokenKind.COMMA)) {
                break;
            }
        }
        return members;
    }

    parseTypedef(): TypedefDeclNode {
        const start = this.parser.state.next().span; // typedef
        let type = this.parser.types.parseTypeSpec();
        // Handle function pointer typedefs: typedef RetType (*Name)(Params);
        if (this.parser.state.peek().kind === TokenKind.L_PAREN && this.parser.state.peek(1).kind === TokenKind.STAR) {
            this.parser.state.next(); // (
            this.parser.state.next(); // *
            const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "typedef function pointer name");
            this.parser.state.expect(TokenKind.R_PAREN, "typedef function pointer");
            // Skip parameter list
            if (this.parser.state.peek().kind === TokenKind.L_PAREN) {
                this.parser.recovery.skipBalanced(TokenKind.L_PAREN, TokenKind.R_PAREN);
            }
            this.parser.state.expect(TokenKind.SEMICOLON, "typedef");
            // Return a simplified typedef — the exact signature doesn't matter for our subset
            return {
                kind: AstKind.TYPEDEF_DECL,
                name: nameTok?.text ?? "fn_ptr",
                type: { kind: AstKind.POINTER, pointee: { kind: AstKind.VOID } },
                span: this.parser.recovery.makeSpan(start),
            };
        }
        const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "typedef name");
        this.parser.state.expect(TokenKind.SEMICOLON, "typedef");
        return { kind: AstKind.TYPEDEF_DECL, name: nameTok?.text ?? "", type, span: this.parser.recovery.makeSpan(start) };
    }

    parseUsing(): Declaration {
        this.parser.state.next(); // using
        // using namespace QPI;
        if (this.parser.state.tryConsumeKeyword("namespace")) {
            const nameTok = this.parser.state.expect(TokenKind.IDENTIFIER, "namespace name");
            this.parser.state.expect(TokenKind.SEMICOLON, "using namespace");
            return {
                kind: AstKind.TYPEDEF_DECL,
                name: `using namespace ${nameTok?.text ?? ""}`,
                type: { kind: AstKind.VOID },
                span: this.parser.state.peek().span,
            };
        }
        // using Alias = Type;
        const name = this.parser.types.parseQualifiedName();
        if (this.parser.state.tryConsume(TokenKind.EQ)) {
            const type = this.parser.types.parseTypeSpec();
            this.parser.state.expect(TokenKind.SEMICOLON, "using alias");
            return {
                kind: AstKind.TYPEDEF_DECL,
                name,
                type,
                span: this.parser.state.peek().span,
            };
        }
        // using Base::member;
        this.parser.state.expect(TokenKind.SEMICOLON, "using decl");
        return {
            kind: AstKind.TYPEDEF_DECL,
            name,
            type: { kind: AstKind.VOID },
            span: this.parser.state.peek().span,
        };
    }

    parseStaticAssertDecl(): StaticAssertDecl {
        const start = this.parser.state.next().span; // static_assert
        this.parser.state.expect(TokenKind.L_PAREN, "static_assert");
        const condition = this.parser.expressions.parseExpression();
        let message: Expression | undefined;
        if (this.parser.state.tryConsume(TokenKind.COMMA)) {
            message = this.parser.expressions.parsePrimaryExpression();
        }
        this.parser.state.expect(TokenKind.R_PAREN, "static_assert");
        this.parser.state.expect(TokenKind.SEMICOLON, "static_assert");
        return { kind: AstKind.STATIC_ASSERT_DECL, condition, message, span: this.parser.recovery.makeSpan(start) };
    }

    parseExternBlock(): ExternBlockDecl | FunctionDecl {
        const start = this.parser.state.next().span; // extern
        // extern "C" { ... }
        if (this.parser.state.peek().kind === TokenKind.STRING_LITERAL) {
            const linkage = this.parser.state.next().text.replace(/"/g, "");
            if (this.parser.state.tryConsume(TokenKind.L_BRACE)) {
                const body = this.parser.declarations.parseDeclarationList();
                this.parser.state.expect(TokenKind.R_BRACE, "extern block");
                return { kind: AstKind.EXTERN_BLOCK, linkage, body, span: this.parser.recovery.makeSpan(start) };
            }
            // extern "C" function declaration
            const func = this.parser.functions.parseFunctionAfterReturnType({ kind: AstKind.NAME, name: "void" }, true);
            return func;
        }
        // extern function
        const func = this.parser.functions.parseFunctionAfterReturnType({ kind: AstKind.NAME, name: "void" }, true);
        return func;
    }

    parseFriend(): FriendDecl {
        const start = this.parser.state.next().span; // friend
        const declaration = this.parser.declarations.parseDeclaration();
        if (!declaration) {
            return {
                kind: AstKind.FRIEND,
                declaration: {
                    kind: AstKind.FUNCTION,
                    name: "",
                    returnType: { kind: AstKind.VOID },
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
            kind: AstKind.FRIEND,
            declaration: declaration as FunctionDecl | StructDecl | ClassTemplateDecl,
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseAccessSpec(): EmptyDecl {
        this.parser.state.next(); // public/protected/private
        this.parser.state.expect(TokenKind.COLON, "access specifier");
        return { kind: AstKind.EMPTY };
    }
}
