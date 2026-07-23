import { AccessSpec, AstKind, TokenKind } from "../../../enums";
import type {
    Declaration,
    Expression,
    FunctionDecl,
    ParamDecl,
    Statement,
    TypeSpec,
    VariableDecl,
} from "../../../ast";
import type { Parser } from "../parser";

export class FunctionParser {
    constructor(private readonly parser: Parser) {}

    parseFunctionOrVariable(): Declaration {
        let isConstexpr = false;
        let isStatic = false;
        let isInline = false;
        let isVirtual = false;
        let isExtern = false;
        // Consume modifiers
        while (!this.parser.state.eof()) {
            if (this.parser.state.tryConsumeKeyword("constexpr")) {
                isConstexpr = true;
            }
            else if (this.parser.state.tryConsumeKeyword("static")) {
                isStatic = true;
            }
            else if (this.parser.state.tryConsumeKeyword("inline")) {
                isInline = true;
            }
            else if (this.parser.state.tryConsumeKeyword("virtual")) {
                isVirtual = true;
            }
            else if (this.parser.state.tryConsumeKeyword("extern")) {
                isExtern = true;
            }
            else {
                break;
            }
        }
        return this.parser.functions.parseAfterModifiers(isConstexpr, isStatic, isInline, isVirtual, isExtern);
    }

    parseFunctionOrVariablePeekType(): Declaration {
        return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
    }

    parseIdentifierDeclaration(): Declaration {
        // Identifier at top level — peek ahead
        const tok = this.parser.state.peek();
        const nextTok = this.parser.state.peek(1);
        // Identifier followed by "::" → qualified name (function/variable)
        if (nextTok.kind === TokenKind.D_COLON) {
            return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
        }
        // Identifier followed by "(" → function definition
        if (nextTok.kind === TokenKind.L_PAREN) {
            return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
        }
        // Identifier followed by ";" → variable declaration Identifier followed by "=" → variable with init
        if (nextTok.kind === TokenKind.SEMICOLON || nextTok.kind === TokenKind.EQ) {
            return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
        }
        // Assume variable declaration
        return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
    }

    parseAfterModifiers(isConstexpr: boolean, isStatic: boolean, isInline: boolean, isVirtual: boolean, isExtern: boolean): Declaration {
        // Parse return type (or variable type)
        const type = this.parser.types.parseTypeSpec();
        // Check for function call syntax: Type(...) or Type::name(
        const name = this.parser.types.parseMaybeQualifiedName();
        if (!name) {
            // Constructors and destructors have no return type.
            if (this.parser.state.peek().kind === TokenKind.L_PAREN && type.kind === AstKind.NAME) {
                return this.parser.functions.parseFunctionRest(type.name, { kind: AstKind.VOID }, isConstexpr, isStatic, isInline, isVirtual, isExtern);
            }
            // Just a type with no name — semicolon
            this.parser.state.expect(TokenKind.SEMICOLON, "declaration");
            return { kind: AstKind.EMPTY };
        }
        // Distinguish functions from constructor-style direct initialization.
        if (this.parser.state.peek().kind === TokenKind.L_PAREN) {
            if (this.parser.functions.looksLikeDirectInit()) {
                return this.parser.functions.parseDirectInitVar(name, type, isConstexpr, isStatic);
            }
            return this.parser.functions.parseFunctionRest(name, type, isConstexpr, isStatic, isInline, isVirtual, isExtern);
        }
        // Variable: name; or name = init;
        return this.parser.functions.parseVariableRest(name, type, isConstexpr, isStatic);
    }

    looksLikeDirectInit(): boolean {
        const after = this.parser.state.peek(1).kind;
        return (after === TokenKind.KW_SIZEOF ||
            after === TokenKind.INT_LITERAL ||
            after === TokenKind.FLOAT_LITERAL ||
            after === TokenKind.STRING_LITERAL ||
            after === TokenKind.CHAR_LITERAL ||
            after === TokenKind.KW_TRUE ||
            after === TokenKind.KW_FALSE ||
            after === TokenKind.KW_NULLPTR ||
            after === TokenKind.MINUS ||
            // A parameter list cannot start with a braced constructor argument.
            after === TokenKind.BANG ||
            after === TokenKind.TILDE ||
            after === TokenKind.L_BRACE);
    }

    parseDirectInitVar(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): VariableDecl {
        const start = this.parser.state.peek().span;
        this.parser.state.expect(TokenKind.L_PAREN, "ctor args");
        const callArguments: Expression[] = [];
        if (this.parser.state.peek().kind !== TokenKind.R_PAREN) {
            callArguments.push(this.parser.expressions.parseExpression());
            while (this.parser.state.tryConsume(TokenKind.COMMA)) {
                callArguments.push(this.parser.expressions.parseExpression());
            }
        }
        this.parser.state.expect(TokenKind.R_PAREN, "ctor args close");
        this.parser.state.expect(TokenKind.SEMICOLON, "direct-init declaration");
        return {
            kind: AstKind.VARIABLE,
            name,
            type,
            initializer: { kind: AstKind.CONSTRUCT, type, callArguments, span: start },
            isConstexpr,
            isStatic,
            isExtern: false,
            isMember: false,
            access: AccessSpec.PUBLIC,
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseFunctionAfterReturnType(retType: TypeSpec, isExternC: boolean): FunctionDecl {
        const name = this.parser.types.parseMaybeQualifiedName() ?? "";
        const isConstexpr = false;
        return this.parser.functions.parseFunctionRest(name, retType, isConstexpr, false, false, false, isExternC);
    }

    parseFunctionRest(name: string, retType: TypeSpec, isConstexpr: boolean, isStatic: boolean, isInline: boolean, isVirtual: boolean, isExternC: boolean): FunctionDecl {
        const start = this.parser.state.peek(-1)?.span || this.parser.state.peek().span;
        // Function parameters
        this.parser.state.expect(TokenKind.L_PAREN, "function params");
        const params = this.parser.functions.parseFunctionParams();
        this.parser.state.expect(TokenKind.R_PAREN, "function params close");
        // Optional const qualifier
        this.parser.state.tryConsumeKeyword("const");
        // Optional override/final/noexcept
        const isOverride = !!this.parser.state.tryConsumeKeyword("override");
        this.parser.state.tryConsumeKeyword("final");
        this.parser.state.tryConsumeKeyword("noexcept");
        let body: Statement | undefined;
        let isDeleted = false;
        let isDefault = false;
        if (this.parser.state.tryConsume(TokenKind.EQ)) {
            if (this.parser.state.tryConsumeKeyword("delete")) {
                isDeleted = true;
            }
            else if (this.parser.state.tryConsumeKeyword("default")) {
                isDefault = true;
            }
            this.parser.state.expect(TokenKind.SEMICOLON, "function = delete/default");
        }
        else if (this.parser.state.peek().kind === TokenKind.L_BRACE) {
            body = this.parser.parseFunctionBody();
        }
        else {
            this.parser.state.expect(TokenKind.SEMICOLON, "function declaration");
        }
        return {
            kind: AstKind.FUNCTION,
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
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseVariableRest(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): Declaration {
        const vars = this.parser.functions.parseDeclaratorList(type, name, isConstexpr, isStatic);
        // First declarator is returned; the rest are queued for the enclosing member/decl loop.
        for (let varIndex = 1; varIndex < vars.length; varIndex++)
            this.parser.state.pendingDeclarations.push(vars[varIndex]);
        return vars[0] ?? { kind: AstKind.EMPTY };
    }

    parseDeclaratorList(baseType: TypeSpec, firstName: string, isConstexpr: boolean, isStatic: boolean): VariableDecl[] {
        const out: VariableDecl[] = [];
        let name = firstName;
        while (true) {
            const start = this.parser.state.peek().span;
            let type = baseType;
            // Array dimensions: name[E][E2]... — innermost dimension binds tightest, so collect then nest.
            const dims: Expression[] = [];
            while (this.parser.state.peek().kind === TokenKind.L_BRACKET) {
                this.parser.state.next(); // [
                if (this.parser.state.peek().kind === TokenKind.R_BRACKET) {
                    dims.push({ kind: AstKind.INT_LITERAL, value: "0", span: this.parser.state.peek().span });
                }
                else {
                    dims.push(this.parser.expressions.parseExpression());
                }
                this.parser.state.expect(TokenKind.R_BRACKET, "array dimension");
            }
            for (let index = dims.length - 1; index >= 0; index--) {
                type = { kind: AstKind.ARRAY, element: type, size: dims[index], span: start };
            }
            let initializer: Expression | undefined;
            if (this.parser.state.tryConsume(TokenKind.EQ)) {
                initializer = this.parser.expressions.parseExpression();
            }
            else if (this.parser.state.peek().kind === TokenKind.L_BRACE) {
                // Preserve direct-list initialization in the executable AST.
                const list = this.parser.expressions.parseExpression();
                initializer =
                    type.kind === AstKind.ARRAY || list.kind !== AstKind.INITIALIZER_LIST
                        ? list
                        : { kind: AstKind.CONSTRUCT, type, callArguments: list.expressions, span: list.span };
            }
            out.push({
                kind: AstKind.VARIABLE,
                name,
                type,
                initializer,
                isConstexpr,
                isStatic,
                isExtern: false,
                isMember: false,
                access: AccessSpec.PUBLIC,
                span: this.parser.recovery.makeSpan(start),
            });
            if (this.parser.state.tryConsume(TokenKind.COMMA)) {
                // next declarator: optional * / & then a name
                while (this.parser.state.peek().kind === TokenKind.STAR || this.parser.state.peek().kind === TokenKind.AMP)
                    this.parser.state.next();
                const token = this.parser.state.peek();
                if (token.kind === TokenKind.IDENTIFIER) {
                    name = this.parser.state.next().text;
                    continue;
                }
            }
            break;
        }
        this.parser.state.expect(TokenKind.SEMICOLON, "variable");
        return out;
    }

    parseFunctionParams(): ParamDecl[] {
        const params: ParamDecl[] = [];
        if (this.parser.state.peek().kind === TokenKind.R_PAREN) {
            return params;
        }
        if (this.parser.state.peek().kind === TokenKind.KW_VOID && this.parser.state.peek(1).kind === TokenKind.R_PAREN) {
            this.parser.state.next(); // void
            return params;
        }
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_PAREN) {
            let type = this.parser.types.parseTypeSpec();
            let name = "";
            // Function pointers remain addresses in the parsed ABI and still participate in overload
            // resolution; generated Wasm does not call their pointee signatures.
            if (this.parser.state.peek().kind === TokenKind.L_PAREN && this.parser.state.peek(1).kind === TokenKind.STAR) {
                this.parser.state.next();
                this.parser.state.next();
                if (this.parser.state.peek().kind === TokenKind.IDENTIFIER)
                    name = this.parser.state.next().text;
                this.parser.state.expect(TokenKind.R_PAREN, "function-pointer declarator");
                this.parser.state.expect(TokenKind.L_PAREN, "function-pointer parameters");
                let depth = 1;
                while (!this.parser.state.eof() && depth > 0) {
                    const token = this.parser.state.next();
                    if (token.kind === TokenKind.L_PAREN)
                        depth++;
                    else if (token.kind === TokenKind.R_PAREN)
                        depth--;
                }
                type = { kind: AstKind.POINTER, pointee: type, span: type.span };
            }
            if (!name && this.parser.state.peek().kind === TokenKind.IDENTIFIER) {
                name = this.parser.state.next().text;
            }
            let defaultVal: Expression | undefined;
            if (this.parser.state.tryConsume(TokenKind.EQ)) {
                defaultVal = this.parser.expressions.parseExpression();
            }
            params.push({ name, type, defaultValue: defaultVal, span: this.parser.state.peek().span });
            if (!this.parser.state.tryConsume(TokenKind.COMMA)) {
                break;
            }
        }
        return params;
    }
}
