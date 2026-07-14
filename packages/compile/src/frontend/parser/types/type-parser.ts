import type { Expression, TypeSpec } from "../../../ast";
import { isTypeKeyword } from "../../../lexer";
import type { Parser } from "../parser";

const SCALAR_CAST_NAMES = new Set([
    "sint8",
    "uint8",
    "sint16",
    "uint16",
    "sint32",
    "uint32",
    "sint64",
    "uint64",
    "bit",
    "uint128",
    "uint128_t",
    "size_t",
    "int8_t",
    "uint8_t",
    "int16_t",
    "uint16_t",
    "int32_t",
    "uint32_t",
    "int64_t",
    "uint64_t",
]);

export class TypeParser {
    constructor(private readonly parser: Parser) {}

    parseTypeSpec(): TypeSpec {
        let type = this.parser.types.parseBaseType();
        // Trailing modifiers: *, &, const
        while (!this.parser.state.eof()) {
            if (this.parser.state.tryConsume("star")) {
                type = { kind: "pointer", pointee: type, span: type.span };
            }
            else if (this.parser.state.peek().kind === "amp" &&
                this.parser.state.peek(1).kind !== "amp" &&
                this.parser.state.peek(1).kind !== "eq") {
                // & (but not && or &=)
                this.parser.state.next();
                type = { kind: "reference", referentType: type, span: type.span };
            }
            else if (this.parser.state.tryConsumeKeyword("const")) {
                type = { kind: "const", valueType: type, span: type.span };
            }
            else {
                break;
            }
        }
        return type;
    }

    parseBaseType(): TypeSpec {
        const tok = this.parser.state.peek();
        // const prefix (e.g., "const Type&")
        if (tok.kind === "kw_const") {
            this.parser.state.next(); // consume const
            const inner = this.parser.types.parseBaseType();
            return { kind: "const", valueType: inner, span: tok.span };
        }
        // auto — type inferred from the initializer (in qpi.h bodies these are integer counters / pointers)
        if (tok.kind === "kw_auto") {
            this.parser.state.next();
            return { kind: "name", name: "auto", span: tok.span };
        }
        // `typename` is a parse-time disambiguator (typename Sel<v>::type) — drop it and parse the type that follows; any trailing
        if (tok.kind === "kw_typename") {
            this.parser.state.next();
            return this.parser.types.parseBaseType();
        }
        // Built-in type keywords
        if (isTypeKeyword(tok.kind)) {
            return this.parser.types.parseBuiltinType();
        }
        // struct / enum / class / union prefix
        if (tok.kind === "kw_struct" ||
            tok.kind === "kw_enum" ||
            tok.kind === "kw_class" ||
            tok.kind === "kw_union") {
            this.parser.state.next();
            const name = this.parser.state.next().text;
            return { kind: "name", name, span: tok.span };
        }
        // unsigned / signed prefixes
        if (tok.kind === "kw_unsigned" || tok.kind === "kw_signed" || tok.kind === "kw_long") {
            return this.parser.types.parseBuiltinType();
        }
        // Name or qualified name. In a type position, `Sel<args>::member` is a dependent type — stop the
        const name = this.parser.types.parseQualifiedName(true);
        if (!name) {
            this.parser.state.diagnostics.push({
                severity: "error",
                message: `Expected type but got ${tok.kind}`,
                span: tok.span,
            });
            this.parser.state.next();
            return { kind: "name", name: "int", span: tok.span };
        }
        // Check for template arguments: Name<...>
        if (this.parser.state.peek().kind === "l_angle") {
            this.parser.state.next(); // <
            const callArguments: TypeSpec[] = [];
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_angle") {
                const kind = this.parser.state.peek().kind;
                // Non-type arg that is a value expression (literal, paren, sizeof, `-N`, `~N`) — parse at shift precedence so
                if (kind === "int_literal" ||
                    kind === "l_paren" ||
                    kind === "kw_sizeof" ||
                    kind === "char_literal" ||
                    kind === "minus" ||
                    kind === "tilde" ||
                    kind === "kw_true" ||
                    kind === "kw_false" ||
                    this.parser.types.templateArgIsExpr()) {
                    callArguments.push({ kind: "expr_value", expression: this.parser.expressions.parseShift(), span: this.parser.state.peek().span });
                }
                else if (kind === "d_colon" ||
                    kind === "identifier" ||
                    isTypeKeyword(kind) ||
                    kind === "kw_const" ||
                    kind === "kw_struct" ||
                    kind === "kw_unsigned" ||
                    kind === "kw_signed") {
                    callArguments.push(this.parser.types.parseTypeSpec());
                }
                else {
                    const name = this.parser.types.parseMaybeQualifiedName() || this.parser.state.next().text;
                    callArguments.push({ kind: "name", name, span: this.parser.state.peek().span });
                }
                if (!this.parser.state.tryConsume("comma")) {
                    break;
                }
            }
            this.parser.state.consumeTemplateAngleClose();
            const inst: TypeSpec = { kind: "template_instance", name, callArguments, span: tok.span };
            // Dependent member type: `Selector<args>::type` — the nested type of a template instance.
            if (this.parser.state.peek().kind === "d_colon" && this.parser.state.peek(1).kind === "identifier") {
                this.parser.state.next(); // ::
                const member = this.parser.state.next().text;
                return { kind: "dependent_member", base: inst, member, span: tok.span };
            }
            return inst;
        }
        return { kind: "name", name, span: tok.span };
    }

    templateArgIsExpr(): boolean {
        if (this.parser.state.peek().kind !== "identifier")
            return false;
        let index = 1;
        while (this.parser.state.peek(index).kind === "d_colon" && this.parser.state.peek(index + 1).kind === "identifier")
            index += 2;
        const operator = this.parser.state.peek(index).kind;
        if (operator !== "star" &&
            operator !== "plus" &&
            operator !== "slash" &&
            operator !== "percent" &&
            operator !== "l_shift" &&
            operator !== "r_shift")
            return false;
        const after = this.parser.state.peek(index + 1).kind;
        return after === "identifier" || after === "int_literal" || after === "l_paren";
    }

    parseBuiltinType(): TypeSpec {
        // Handle signed/unsigned + char/short/int/long/long long
        const parts: string[] = [];
        while (!this.parser.state.eof() && isTypeKeyword(this.parser.state.peek().kind)) {
            parts.push(this.parser.state.next().text);
        }
        const name = parts.join(" ");
        return { kind: "name", name, span: this.parser.state.peek().span };
    }

    parseAccessAndType(): TypeSpec {
        // public Type / protected Type / private Type
        this.parser.state.tryConsumeKeyword("public");
        this.parser.state.tryConsumeKeyword("protected");
        this.parser.state.tryConsumeKeyword("private");
        this.parser.state.tryConsumeKeyword("virtual"); // virtual inheritance — ignore in QPI subset
        return this.parser.types.parseTypeSpec();
    }

    parseQualifiedName(stopAtAngle = false): string {
        const parts: string[] = [];
        while (!this.parser.state.eof()) {
            const tok = this.parser.state.peek();
            if (stopAtAngle && tok.kind === "identifier" && this.parser.state.peek(1).kind === "l_angle") {
                // Type position: `Sel<args>::type` is a dependent type — stop here and let the caller capture the template instance
                parts.push(this.parser.state.next().text);
                break;
            }
            if (tok.kind === "kw_operator") {
                // operator overload name: consume `operator` + the operator symbol token(s).
                this.parser.state.next();
                const opTok = this.parser.state.peek();
                if (opTok.kind === "l_paren" && this.parser.state.peek(1).kind === "r_paren") {
                    this.parser.state.next();
                    this.parser.state.next();
                    parts.push("operator()");
                }
                else if (opTok.kind === "l_bracket" && this.parser.state.peek(1).kind === "r_bracket") {
                    this.parser.state.next();
                    this.parser.state.next();
                    parts.push("operator[]");
                }
                else if (opTok.kind === "identifier" ||
                    isTypeKeyword(opTok.kind) ||
                    opTok.kind === "kw_bool") {
                    // conversion operator: operator bool() / operator T()
                    parts.push("operator " + this.parser.state.next().text);
                }
                else {
                    parts.push("operator" + this.parser.state.next().text);
                }
            }
            else if (tok.kind === "identifier") {
                parts.push(this.parser.state.next().text);
                // ClassTemplate<args>::method — out-of-class definition. Drop the qualifier's template args
                if (this.parser.state.peek().kind === "l_angle") {
                    const save = this.parser.state.position;
                    if (this.parser.types.skipAngleArgs() && this.parser.state.peek().kind === "d_colon") {
                        // committed — fall through to the d_colon handler below
                    }
                    else {
                        this.parser.state.position = save;
                    }
                }
            }
            else if (tok.kind === "tilde" && this.parser.state.peek(1).kind === "identifier") {
                // ~ClassName (destructor name)
                this.parser.state.next();
                parts.push("~" + this.parser.state.next().text);
            }
            else {
                break;
            }
            if (this.parser.state.peek().kind === "d_colon") {
                this.parser.state.next(); // ::
                parts.push("::");
                continue;
            }
            break;
        }
        if (parts.length === 0)
            return "";
        return parts.join("");
    }

    parseMaybeQualifiedName(): string {
        return this.parser.types.parseQualifiedName();
    }

    skipAngleArgs(): boolean {
        if (this.parser.state.peek().kind !== "l_angle")
            return false;
        this.parser.state.next(); // <
        let depth = 1, guard = 0;
        while (!this.parser.state.eof() && depth > 0 && guard++ < 500) {
            const kind = this.parser.state.peek().kind;
            if (kind === "l_angle") {
                depth++;
                this.parser.state.next();
                continue;
            }
            if (kind === "r_angle") {
                depth--;
                this.parser.state.next();
                continue;
            }
            if (kind === "r_shift") {
                depth -= 2;
                this.parser.state.next();
                continue;
            }
            if (kind === "semicolon" || kind === "l_brace")
                return false;
            this.parser.state.next();
        }
        return depth <= 0;
    }

    isTypeCast(): boolean {
        const save = this.parser.state.position;
        this.parser.state.next(); // (
        let pureType = true;
        let sawTypeToken = false;
        let depth = 0;
        let saw = false;
        let sawNestedParen = false;
        let angleDepth = 0;
        let sawPtrRef = false;
        let tokenCount = 0;
        let loneIdent: string | null = null;
        let sawAngle = false;
        while (!this.parser.state.eof()) {
            const token = this.parser.state.peek();
            // In this subset, C-style casts have no parenthesized nested expressions.
            if (token.kind === "l_paren") {
                depth++;
                sawNestedParen = true;
                this.parser.state.next();
                continue;
            }
            if (token.kind === "r_paren") {
                if (depth === 0) {
                    this.parser.state.next();
                    break;
                }
                depth--;
                this.parser.state.next();
                continue;
            }
            saw = true;
            const ok = isTypeKeyword(token.kind) ||
                token.kind === "kw_unsigned" ||
                token.kind === "kw_signed" ||
                token.kind === "kw_const" ||
                token.kind === "kw_struct" ||
                token.kind === "kw_enum" ||
                token.kind === "kw_class" ||
                token.kind === "star" ||
                token.kind === "amp" ||
                token.kind === "d_colon" ||
                token.kind === "l_angle" ||
                token.kind === "r_angle" ||
                token.kind === "r_shift" ||
                token.kind === "comma" ||
                token.kind === "identifier";
            // C-style casts here only target scalar type spellings.
            if (token.kind === "l_angle" && depth === 0)
                sawAngle = true;
            if ((token.kind === "r_angle" || token.kind === "r_shift") && angleDepth === 0)
                pureType = false;
            if (token.kind === "l_angle")
                angleDepth++;
            if (token.kind === "r_angle")
                angleDepth = Math.max(0, angleDepth - 1);
            if (token.kind === "r_shift")
                angleDepth = Math.max(0, angleDepth - 2);
            // In type-id context, `*`/`&` act as declarator suffixes inside template-free area.
            if ((token.kind === "star" || token.kind === "amp") && angleDepth === 0)
                sawPtrRef = true;
            if (sawPtrRef &&
                angleDepth === 0 &&
                (token.kind === "identifier" || token.kind === "d_colon" || isTypeKeyword(token.kind))) {
                pureType = false;
            }
            if (isTypeKeyword(token.kind) || token.kind === "identifier")
                sawTypeToken = true;
            if (!ok) {
                pureType = false;
            }
            tokenCount++;
            loneIdent = tokenCount === 1 && token.kind === "identifier" ? token.text : null;
            this.parser.state.next();
        }
        // After the `)`, a cast must be followed by an operand (so `(id) + 5` is NOT a cast).
        const after = this.parser.state.peek();
        const operandFollows = after.kind === "identifier" ||
            after.kind === "int_literal" ||
            after.kind === "l_paren" ||
            after.kind === "bang" ||
            after.kind === "tilde" ||
            after.kind === "minus" ||
            after.kind === "plus" ||
            after.kind === "amp" ||
            after.kind === "star" ||
            after.kind === "kw_true" ||
            after.kind === "kw_false" ||
            after.kind === "char_literal" ||
            after.kind === "string_literal" ||
            after.kind === "kw_this" ||
            after.kind === "kw_sizeof";
        this.parser.state.position = save;
        // `(name) & x` / `(name) * x` / `(name) + x` / `(name) - x`: C++ resolves this
        if (loneIdent &&
            !SCALAR_CAST_NAMES.has(loneIdent) &&
            (after.kind === "amp" ||
                after.kind === "star" ||
                after.kind === "plus" ||
                after.kind === "minus")) {
            return false;
        }
        // A bare identifier in parens (`(L * 2 ...)` has operators → not pure) is a cast only
        return saw && pureType && sawTypeToken && operandFollows && !sawNestedParen && !sawAngle;
    }

    parseCast(): Expression {
        this.parser.state.next(); // (
        const type = this.parser.types.parseTypeSpec();
        this.parser.state.expect("r_paren", "cast");
        const expression = this.parser.expressions.parseUnary();
        return { kind: "c_cast", type, expression, span: expression.span };
    }

    parseSizeof(): Expression {
        const start = this.parser.state.next().span; // sizeof
        if (this.parser.state.tryConsume("l_paren")) {
            // sizeof(T) or sizeof(expr) Check if it's a type
            const tok = this.parser.state.peek();
            if (isTypeKeyword(tok.kind) ||
                tok.kind === "kw_unsigned" ||
                tok.kind === "kw_signed" ||
                tok.kind === "kw_struct" ||
                tok.kind === "kw_enum" ||
                tok.kind === "kw_const" ||
                tok.kind === "kw_typename") {
                const type = this.parser.types.parseTypeSpec();
                this.parser.state.expect("r_paren", "sizeof type");
                return { kind: "sizeof_type", type, span: this.parser.recovery.makeSpan(start) };
            }
            const expression = this.parser.expressions.parseExpression();
            this.parser.state.expect("r_paren", "sizeof expr");
            return { kind: "sizeof_expr", expression, span: this.parser.recovery.makeSpan(start) };
        }
        // sizeof expr (without parens)
        const expression = this.parser.expressions.parseUnary();
        return { kind: "sizeof_expr", expression, span: this.parser.recovery.makeSpan(start) };
    }
}
