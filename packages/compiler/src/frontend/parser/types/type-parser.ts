import { AstKind, DiagnosticSeverity, TokenKind } from "../../../enums";
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
            if (this.parser.state.tryConsume(TokenKind.STAR)) {
                type = { kind: AstKind.POINTER, pointee: type, span: type.span };
            }
            else if (this.parser.state.peek().kind === TokenKind.AMP &&
                this.parser.state.peek(1).kind !== TokenKind.AMP &&
                this.parser.state.peek(1).kind !== TokenKind.EQ) {
                // & (but not && or &=)
                this.parser.state.next();
                type = { kind: AstKind.REFERENCE, referentType: type, span: type.span };
            }
            else if (this.parser.state.tryConsumeKeyword("const")) {
                type = { kind: AstKind.CONST, valueType: type, span: type.span };
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
        if (tok.kind === TokenKind.KW_CONST) {
            this.parser.state.next(); // consume const
            const inner = this.parser.types.parseBaseType();
            return { kind: AstKind.CONST, valueType: inner, span: tok.span };
        }
        // auto — type inferred from the initializer (in qpi.h bodies these are integer counters / pointers)
        if (tok.kind === TokenKind.KW_AUTO) {
            this.parser.state.next();
            return { kind: AstKind.NAME, name: "auto", span: tok.span };
        }
        // Drop the parse-only `typename` disambiguator before reading its type.
        if (tok.kind === TokenKind.KW_TYPENAME) {
            this.parser.state.next();
            return this.parser.types.parseBaseType();
        }
        // Built-in type keywords
        if (isTypeKeyword(tok.kind)) {
            return this.parser.types.parseBuiltinType();
        }
        // struct / enum / class / union prefix
        if (tok.kind === TokenKind.KW_STRUCT ||
            tok.kind === TokenKind.KW_ENUM ||
            tok.kind === TokenKind.KW_CLASS ||
            tok.kind === TokenKind.KW_UNION) {
            this.parser.state.next();
            const name = this.parser.state.next().text;
            return { kind: AstKind.NAME, name, span: tok.span };
        }
        // unsigned / signed prefixes
        if (tok.kind === TokenKind.KW_UNSIGNED || tok.kind === TokenKind.KW_SIGNED || tok.kind === TokenKind.KW_LONG) {
            return this.parser.types.parseBuiltinType();
        }
        // Parse a name, stopping before dependent template arguments.
        const name = this.parser.types.parseQualifiedName(true);
        if (!name) {
            this.parser.state.diagnostics.push({
                severity: DiagnosticSeverity.ERROR,
                message: `Expected type but got ${tok.kind}`,
                span: tok.span,
            });
            this.parser.state.next();
            return { kind: AstKind.NAME, name: "int", span: tok.span };
        }
        // Check for template arguments: Name<...>
        if (this.parser.state.peek().kind === TokenKind.L_ANGLE) {
            this.parser.state.next(); // <
            const callArguments: TypeSpec[] = [];
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_ANGLE) {
                const kind = this.parser.state.peek().kind;
                // Parse value template arguments at shift precedence to preserve the closing `>`.
                if (kind === TokenKind.INT_LITERAL ||
                    kind === TokenKind.L_PAREN ||
                    kind === TokenKind.KW_SIZEOF ||
                    kind === TokenKind.CHAR_LITERAL ||
                    kind === TokenKind.MINUS ||
                    kind === TokenKind.TILDE ||
                    kind === TokenKind.KW_TRUE ||
                    kind === TokenKind.KW_FALSE ||
                    this.parser.types.templateArgIsExpr()) {
                    callArguments.push({ kind: AstKind.EXPR_VALUE, expression: this.parser.expressions.parseShift(), span: this.parser.state.peek().span });
                }
                else if (kind === TokenKind.D_COLON ||
                    kind === TokenKind.IDENTIFIER ||
                    isTypeKeyword(kind) ||
                    kind === TokenKind.KW_CONST ||
                    kind === TokenKind.KW_STRUCT ||
                    kind === TokenKind.KW_UNSIGNED ||
                    kind === TokenKind.KW_SIGNED) {
                    callArguments.push(this.parser.types.parseTypeSpec());
                }
                else {
                    const name = this.parser.types.parseMaybeQualifiedName() || this.parser.state.next().text;
                    callArguments.push({ kind: AstKind.NAME, name, span: this.parser.state.peek().span });
                }
                if (!this.parser.state.tryConsume(TokenKind.COMMA)) {
                    break;
                }
            }
            this.parser.state.consumeTemplateAngleClose();
            const inst: TypeSpec = { kind: AstKind.TEMPLATE_INSTANCE, name, callArguments, span: tok.span };
            // Dependent member type: `Selector<args>::type` — the nested type of a template instance.
            if (this.parser.state.peek().kind === TokenKind.D_COLON && this.parser.state.peek(1).kind === TokenKind.IDENTIFIER) {
                this.parser.state.next(); // ::
                const member = this.parser.state.next().text;
                return { kind: AstKind.DEPENDENT_MEMBER, base: inst, member, span: tok.span };
            }
            return inst;
        }
        return { kind: AstKind.NAME, name, span: tok.span };
    }

    templateArgIsExpr(): boolean {
        if (this.parser.state.peek().kind !== TokenKind.IDENTIFIER)
            return false;
        let index = 1;
        while (this.parser.state.peek(index).kind === TokenKind.D_COLON && this.parser.state.peek(index + 1).kind === TokenKind.IDENTIFIER)
            index += 2;
        const operator = this.parser.state.peek(index).kind;
        if (operator !== TokenKind.STAR &&
            operator !== TokenKind.PLUS &&
            operator !== TokenKind.SLASH &&
            operator !== TokenKind.PERCENT &&
            operator !== TokenKind.L_SHIFT &&
            operator !== TokenKind.R_SHIFT)
            return false;
        const after = this.parser.state.peek(index + 1).kind;
        return after === TokenKind.IDENTIFIER || after === TokenKind.INT_LITERAL || after === TokenKind.L_PAREN;
    }

    parseBuiltinType(): TypeSpec {
        // Handle signed/unsigned + char/short/int/long/long long
        const parts: string[] = [];
        while (!this.parser.state.eof() && isTypeKeyword(this.parser.state.peek().kind)) {
            parts.push(this.parser.state.next().text);
        }
        const name = parts.join(" ");
        return { kind: AstKind.NAME, name, span: this.parser.state.peek().span };
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
            if (stopAtAngle && tok.kind === TokenKind.IDENTIFIER && this.parser.state.peek(1).kind === TokenKind.L_ANGLE) {
                // Type position: `Sel<args>::type` is a dependent type — stop here and let the caller capture the template instance
                parts.push(this.parser.state.next().text);
                break;
            }
            if (tok.kind === TokenKind.KW_OPERATOR) {
                // operator overload name: consume `operator` + the operator symbol token(s).
                this.parser.state.next();
                const opTok = this.parser.state.peek();
                if (opTok.kind === TokenKind.L_PAREN && this.parser.state.peek(1).kind === TokenKind.R_PAREN) {
                    this.parser.state.next();
                    this.parser.state.next();
                    parts.push("operator()");
                }
                else if (opTok.kind === TokenKind.L_BRACKET && this.parser.state.peek(1).kind === TokenKind.R_BRACKET) {
                    this.parser.state.next();
                    this.parser.state.next();
                    parts.push("operator[]");
                }
                else if (opTok.kind === TokenKind.IDENTIFIER ||
                    isTypeKeyword(opTok.kind) ||
                    opTok.kind === TokenKind.KW_BOOL) {
                    // conversion operator: operator bool() / operator T()
                    parts.push("operator " + this.parser.state.next().text);
                }
                else {
                    parts.push("operator" + this.parser.state.next().text);
                }
            }
            else if (tok.kind === TokenKind.IDENTIFIER) {
                parts.push(this.parser.state.next().text);
                // ClassTemplate<args>::method — out-of-class definition. Drop the qualifier's template args
                if (this.parser.state.peek().kind === TokenKind.L_ANGLE) {
                    const save = this.parser.state.position;
                    if (this.parser.types.skipAngleArgs() && this.parser.state.peek().kind === TokenKind.D_COLON) {
                        // committed — fall through to the d_colon handler below
                    }
                    else {
                        this.parser.state.position = save;
                    }
                }
            }
            else if (tok.kind === TokenKind.TILDE && this.parser.state.peek(1).kind === TokenKind.IDENTIFIER) {
                // ~ClassName (destructor name)
                this.parser.state.next();
                parts.push("~" + this.parser.state.next().text);
            }
            else {
                break;
            }
            if (this.parser.state.peek().kind === TokenKind.D_COLON) {
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
        if (this.parser.state.peek().kind !== TokenKind.L_ANGLE)
            return false;
        this.parser.state.next(); // <
        let depth = 1, guard = 0;
        while (!this.parser.state.eof() && depth > 0 && guard++ < 500) {
            const kind = this.parser.state.peek().kind;
            if (kind === TokenKind.L_ANGLE) {
                depth++;
                this.parser.state.next();
                continue;
            }
            if (kind === TokenKind.R_ANGLE) {
                depth--;
                this.parser.state.next();
                continue;
            }
            if (kind === TokenKind.R_SHIFT) {
                depth -= 2;
                this.parser.state.next();
                continue;
            }
            if (kind === TokenKind.SEMICOLON || kind === TokenKind.L_BRACE)
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
            if (token.kind === TokenKind.L_PAREN) {
                depth++;
                sawNestedParen = true;
                this.parser.state.next();
                continue;
            }
            if (token.kind === TokenKind.R_PAREN) {
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
                token.kind === TokenKind.KW_UNSIGNED ||
                token.kind === TokenKind.KW_SIGNED ||
                token.kind === TokenKind.KW_CONST ||
                token.kind === TokenKind.KW_STRUCT ||
                token.kind === TokenKind.KW_ENUM ||
                token.kind === TokenKind.KW_CLASS ||
                token.kind === TokenKind.STAR ||
                token.kind === TokenKind.AMP ||
                token.kind === TokenKind.D_COLON ||
                token.kind === TokenKind.L_ANGLE ||
                token.kind === TokenKind.R_ANGLE ||
                token.kind === TokenKind.R_SHIFT ||
                token.kind === TokenKind.COMMA ||
                token.kind === TokenKind.IDENTIFIER;
            // C-style casts here only target scalar type spellings.
            if (token.kind === TokenKind.L_ANGLE && depth === 0)
                sawAngle = true;
            if ((token.kind === TokenKind.R_ANGLE || token.kind === TokenKind.R_SHIFT) && angleDepth === 0)
                pureType = false;
            if (token.kind === TokenKind.L_ANGLE)
                angleDepth++;
            if (token.kind === TokenKind.R_ANGLE)
                angleDepth = Math.max(0, angleDepth - 1);
            if (token.kind === TokenKind.R_SHIFT)
                angleDepth = Math.max(0, angleDepth - 2);
            // In type-id context, `*`/`&` act as declarator suffixes inside template-free area.
            if ((token.kind === TokenKind.STAR || token.kind === TokenKind.AMP) && angleDepth === 0)
                sawPtrRef = true;
            if (sawPtrRef &&
                angleDepth === 0 &&
                (token.kind === TokenKind.IDENTIFIER || token.kind === TokenKind.D_COLON || isTypeKeyword(token.kind))) {
                pureType = false;
            }
            if (isTypeKeyword(token.kind) || token.kind === TokenKind.IDENTIFIER)
                sawTypeToken = true;
            if (!ok) {
                pureType = false;
            }
            tokenCount++;
            loneIdent = tokenCount === 1 && token.kind === TokenKind.IDENTIFIER ? token.text : null;
            this.parser.state.next();
        }
        // After the `)`, a cast must be followed by an operand (so `(id) + 5` is NOT a cast).
        const after = this.parser.state.peek();
        const operandFollows = after.kind === TokenKind.IDENTIFIER ||
            after.kind === TokenKind.INT_LITERAL ||
            after.kind === TokenKind.L_PAREN ||
            after.kind === TokenKind.BANG ||
            after.kind === TokenKind.TILDE ||
            after.kind === TokenKind.MINUS ||
            after.kind === TokenKind.PLUS ||
            after.kind === TokenKind.AMP ||
            after.kind === TokenKind.STAR ||
            after.kind === TokenKind.KW_TRUE ||
            after.kind === TokenKind.KW_FALSE ||
            after.kind === TokenKind.CHAR_LITERAL ||
            after.kind === TokenKind.STRING_LITERAL ||
            after.kind === TokenKind.KW_THIS ||
            after.kind === TokenKind.KW_SIZEOF;
        this.parser.state.position = save;
        // C++ parses these forms as expressions rather than casts.
        if (loneIdent &&
            !SCALAR_CAST_NAMES.has(loneIdent) &&
            (after.kind === TokenKind.AMP ||
                after.kind === TokenKind.STAR ||
                after.kind === TokenKind.PLUS ||
                after.kind === TokenKind.MINUS)) {
            return false;
        }
        // A parenthesized identifier is a cast only when a valid operand follows.
        return saw && pureType && sawTypeToken && operandFollows && !sawNestedParen && !sawAngle;
    }

    parseCast(): Expression {
        this.parser.state.next(); // (
        const type = this.parser.types.parseTypeSpec();
        this.parser.state.expect(TokenKind.R_PAREN, "cast");
        const expression = this.parser.expressions.parseUnary();
        return { kind: AstKind.C_CAST, type, expression, span: expression.span };
    }

    parseSizeof(): Expression {
        const start = this.parser.state.next().span; // sizeof
        if (this.parser.state.tryConsume(TokenKind.L_PAREN)) {
            // sizeof(T) or sizeof(expr) Check if it's a type
            const tok = this.parser.state.peek();
            if (isTypeKeyword(tok.kind) ||
                tok.kind === TokenKind.KW_UNSIGNED ||
                tok.kind === TokenKind.KW_SIGNED ||
                tok.kind === TokenKind.KW_STRUCT ||
                tok.kind === TokenKind.KW_ENUM ||
                tok.kind === TokenKind.KW_CONST ||
                tok.kind === TokenKind.KW_TYPENAME) {
                const type = this.parser.types.parseTypeSpec();
                this.parser.state.expect(TokenKind.R_PAREN, "sizeof type");
                return { kind: AstKind.SIZEOF_TYPE, type, span: this.parser.recovery.makeSpan(start) };
            }
            const expression = this.parser.expressions.parseExpression();
            this.parser.state.expect(TokenKind.R_PAREN, "sizeof expr");
            return { kind: AstKind.SIZEOF_EXPR, expression, span: this.parser.recovery.makeSpan(start) };
        }
        // sizeof expr (without parens)
        const expression = this.parser.expressions.parseUnary();
        return { kind: AstKind.SIZEOF_EXPR, expression, span: this.parser.recovery.makeSpan(start) };
    }
}
