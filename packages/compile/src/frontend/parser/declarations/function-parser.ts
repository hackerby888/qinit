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
        if (nextTok.kind === "d_colon") {
            return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
        }
        // Identifier followed by "(" → function definition
        if (nextTok.kind === "l_paren") {
            return this.parser.functions.parseAfterModifiers(false, false, false, false, false);
        }
        // Identifier followed by ";" → variable declaration Identifier followed by "=" → variable with init
        if (nextTok.kind === "semicolon" || nextTok.kind === "eq") {
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
            if (this.parser.state.peek().kind === "l_paren" && type.kind === "name") {
                return this.parser.functions.parseFunctionRest(type.name, { kind: "void" }, isConstexpr, isStatic, isInline, isVirtual, isExtern);
            }
            // Just a type with no name — semicolon
            this.parser.state.expect("semicolon", "declaration");
            return { kind: "empty" };
        }
        // Distinguish functions from constructor-style direct initialization.
        if (this.parser.state.peek().kind === "l_paren") {
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
        return (after === "kw_sizeof" ||
            after === "int_literal" ||
            after === "float_literal" ||
            after === "string_literal" ||
            after === "char_literal" ||
            after === "kw_true" ||
            after === "kw_false" ||
            after === "kw_nullptr" ||
            after === "minus" ||
            // A parameter list cannot start with a braced constructor argument.
            after === "bang" ||
            after === "tilde" ||
            after === "l_brace");
    }

    parseDirectInitVar(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): VariableDecl {
        const start = this.parser.state.peek().span;
        this.parser.state.expect("l_paren", "ctor args");
        const callArguments: Expression[] = [];
        if (this.parser.state.peek().kind !== "r_paren") {
            callArguments.push(this.parser.expressions.parseExpression());
            while (this.parser.state.tryConsume("comma")) {
                callArguments.push(this.parser.expressions.parseExpression());
            }
        }
        this.parser.state.expect("r_paren", "ctor args close");
        this.parser.state.expect("semicolon", "direct-init declaration");
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
        this.parser.state.expect("l_paren", "function params");
        const params = this.parser.functions.parseFunctionParams();
        this.parser.state.expect("r_paren", "function params close");
        // Optional const qualifier
        this.parser.state.tryConsumeKeyword("const");
        // Optional override/final/noexcept
        const isOverride = !!this.parser.state.tryConsumeKeyword("override");
        this.parser.state.tryConsumeKeyword("final");
        this.parser.state.tryConsumeKeyword("noexcept");
        let body: Statement | undefined;
        let isDeleted = false;
        let isDefault = false;
        if (this.parser.state.tryConsume("eq")) {
            if (this.parser.state.tryConsumeKeyword("delete")) {
                isDeleted = true;
            }
            else if (this.parser.state.tryConsumeKeyword("default")) {
                isDefault = true;
            }
            this.parser.state.expect("semicolon", "function = delete/default");
        }
        else if (this.parser.state.peek().kind === "l_brace") {
            body = this.parser.parseFunctionBody();
        }
        else {
            this.parser.state.expect("semicolon", "function declaration");
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
            span: this.parser.recovery.makeSpan(start),
        };
    }

    parseVariableRest(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): Declaration {
        const vars = this.parser.functions.parseDeclaratorList(type, name, isConstexpr, isStatic);
        // First declarator is returned; the rest are queued for the enclosing member/decl loop.
        for (let varIndex = 1; varIndex < vars.length; varIndex++)
            this.parser.state.pendingDeclarations.push(vars[varIndex]);
        return vars[0] ?? { kind: "empty" };
    }

    parseDeclaratorList(baseType: TypeSpec, firstName: string, isConstexpr: boolean, isStatic: boolean): VariableDecl[] {
        const out: VariableDecl[] = [];
        let name = firstName;
        while (true) {
            const start = this.parser.state.peek().span;
            let type = baseType;
            // Array dimensions: name[E][E2]... — innermost dimension binds tightest, so collect then nest.
            const dims: Expression[] = [];
            while (this.parser.state.peek().kind === "l_bracket") {
                this.parser.state.next(); // [
                if (this.parser.state.peek().kind === "r_bracket") {
                    dims.push({ kind: "int_literal", value: "0", span: this.parser.state.peek().span });
                }
                else {
                    dims.push(this.parser.expressions.parseExpression());
                }
                this.parser.state.expect("r_bracket", "array dimension");
            }
            for (let index = dims.length - 1; index >= 0; index--) {
                type = { kind: "array", element: type, size: dims[index], span: start };
            }
            let initializer: Expression | undefined;
            if (this.parser.state.tryConsume("eq")) {
                initializer = this.parser.expressions.parseExpression();
            }
            else if (this.parser.state.peek().kind === "l_brace") {
                // Preserve direct-list initialization in the executable AST.
                const list = this.parser.expressions.parseExpression();
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
                span: this.parser.recovery.makeSpan(start),
            });
            if (this.parser.state.tryConsume("comma")) {
                // next declarator: optional * / & then a name
                while (this.parser.state.peek().kind === "star" || this.parser.state.peek().kind === "amp")
                    this.parser.state.next();
                const token = this.parser.state.peek();
                if (token.kind === "identifier") {
                    name = this.parser.state.next().text;
                    continue;
                }
            }
            break;
        }
        this.parser.state.expect("semicolon", "variable");
        return out;
    }

    parseFunctionParams(): ParamDecl[] {
        const params: ParamDecl[] = [];
        if (this.parser.state.peek().kind === "r_paren") {
            return params;
        }
        if (this.parser.state.peek().kind === "kw_void" && this.parser.state.peek(1).kind === "r_paren") {
            this.parser.state.next(); // void
            return params;
        }
        while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_paren") {
            let type = this.parser.types.parseTypeSpec();
            let name = "";
            // Function pointers remain addresses in the parsed ABI and still participate in overload
            // resolution; generated Wasm does not call their pointee signatures.
            if (this.parser.state.peek().kind === "l_paren" && this.parser.state.peek(1).kind === "star") {
                this.parser.state.next();
                this.parser.state.next();
                if (this.parser.state.peek().kind === "identifier")
                    name = this.parser.state.next().text;
                this.parser.state.expect("r_paren", "function-pointer declarator");
                this.parser.state.expect("l_paren", "function-pointer parameters");
                let depth = 1;
                while (!this.parser.state.eof() && depth > 0) {
                    const token = this.parser.state.next();
                    if (token.kind === "l_paren")
                        depth++;
                    else if (token.kind === "r_paren")
                        depth--;
                }
                type = { kind: "pointer", pointee: type, span: type.span };
            }
            if (!name && this.parser.state.peek().kind === "identifier") {
                name = this.parser.state.next().text;
            }
            let defaultVal: Expression | undefined;
            if (this.parser.state.tryConsume("eq")) {
                defaultVal = this.parser.expressions.parseExpression();
            }
            params.push({ name, type, defaultValue: defaultVal, span: this.parser.state.peek().span });
            if (!this.parser.state.tryConsume("comma")) {
                break;
            }
        }
        return params;
    }
}
