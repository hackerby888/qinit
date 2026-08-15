import { AssignOp, AstKind, BinaryOp, DiagnosticSeverity, TokenKind, UnaryOp, UpdateOp } from "../../../shared/enums";
import type { Expression, TypeSpec } from "../../../ast";
import type { Parser } from "../parser";

// Binary precedence tiers, loosest first: each maps the tokens accepted at that tier to the operator they
// produce. parseBinaryTier walks these in order, so the array order *is* the precedence.
const enum BinaryTier {
    LOGICAL_OR,
    LOGICAL_AND,
    BITWISE_OR,
    BITWISE_XOR,
    BITWISE_AND,
    EQUALITY,
    COMPARISON,
    SHIFT,
    ADDITIVE,
    MULTIPLICATIVE,
}

const BINARY_TIERS: ReadonlyArray<Record<string, BinaryOp>> = [
    { [TokenKind.PIPE_PIPE]: BinaryOp.LOGICAL_OR },
    { [TokenKind.AMP_AMP]: BinaryOp.LOGICAL_AND },
    { [TokenKind.PIPE]: BinaryOp.BITWISE_OR },
    { [TokenKind.CARET]: BinaryOp.BITWISE_XOR },
    { [TokenKind.AMP]: BinaryOp.BITWISE_AND },
    { [TokenKind.EQ_EQ]: BinaryOp.EQUAL, [TokenKind.NOT_EQ]: BinaryOp.NOT_EQUAL },
    {
        [TokenKind.L_ANGLE]: BinaryOp.LESS_THAN,
        [TokenKind.R_ANGLE]: BinaryOp.GREATER_THAN,
        [TokenKind.LT_EQ]: BinaryOp.LESS_THAN_OR_EQUAL,
        [TokenKind.GT_EQ]: BinaryOp.GREATER_THAN_OR_EQUAL,
        // `<=>` has no dedicated node; it parses at comparison precedence.
        [TokenKind.SPACESHIP]: BinaryOp.LESS_THAN,
    },
    { [TokenKind.L_SHIFT]: BinaryOp.SHIFT_LEFT, [TokenKind.R_SHIFT]: BinaryOp.SHIFT_RIGHT },
    { [TokenKind.PLUS]: BinaryOp.ADD, [TokenKind.MINUS]: BinaryOp.SUBTRACT },
    { [TokenKind.STAR]: BinaryOp.MULTIPLY, [TokenKind.SLASH]: BinaryOp.DIVIDE, [TokenKind.PERCENT]: BinaryOp.MODULO },
];

// `>`, `>=` and `>>` end a template list rather than continuing an expression. They are operators only in
// the comparison and shift tiers, so one shared guard covers both.
const TEMPLATE_LIST_CLOSERS = new Set<string>([TokenKind.R_ANGLE, TokenKind.GT_EQ, TokenKind.R_SHIFT]);

export class ExpressionParser {
    constructor(private readonly parser: Parser) {}

    parseExpression(): Expression {
        return this.parser.expressions.parseAssignment();
    }

    parseAssignment(): Expression {
        const left = this.parser.expressions.parseTernary();
        const tok = this.parser.state.peek();
        const assignOps: Record<string, AssignOp> = {
            eq: AssignOp.ASSIGN,
            plus_eq: AssignOp.ADD,
            minus_eq: AssignOp.SUBTRACT,
            star_eq: AssignOp.MULTIPLY,
            slash_eq: AssignOp.DIVIDE,
            percent_eq: AssignOp.MODULO,
            l_shift_eq: AssignOp.SHIFT_LEFT,
            r_shift_eq: AssignOp.SHIFT_RIGHT,
            amp_eq: AssignOp.BITWISE_AND,
            pipe_eq: AssignOp.BITWISE_OR,
            caret_eq: AssignOp.BITWISE_XOR,
        };
        const operator = assignOps[tok.kind];
        if (operator) {
            this.parser.state.next();
            const right = this.parser.expressions.parseAssignment();
            return { kind: AstKind.ASSIGN, operator, left, right, span: left.span };
        }
        return left;
    }

    parseTernary(): Expression {
        const condition = this.parser.expressions.parseLogicalOr();
        if (this.parser.state.tryConsume(TokenKind.QUESTION)) {
            const then = this.parser.expressions.parseExpression();
            this.parser.state.expect(TokenKind.COLON, "ternary");
            const else_ = this.parser.expressions.parseExpression();
            return { kind: AstKind.TERNARY, condition, then, else_, span: condition.span };
        }
        return condition;
    }

    parseLogicalOr(): Expression {
        return this.parseBinaryTier(BinaryTier.LOGICAL_OR);
    }

    parseLogicalAnd(): Expression {
        return this.parseBinaryTier(BinaryTier.LOGICAL_AND);
    }

    parseBitwiseOr(): Expression {
        return this.parseBinaryTier(BinaryTier.BITWISE_OR);
    }

    parseBitwiseXor(): Expression {
        return this.parseBinaryTier(BinaryTier.BITWISE_XOR);
    }

    parseBitwiseAnd(): Expression {
        return this.parseBinaryTier(BinaryTier.BITWISE_AND);
    }

    parseEquality(): Expression {
        return this.parseBinaryTier(BinaryTier.EQUALITY);
    }

    parseComparison(): Expression {
        return this.parseBinaryTier(BinaryTier.COMPARISON);
    }

    parseShift(): Expression {
        return this.parseBinaryTier(BinaryTier.SHIFT);
    }

    parseAdditive(): Expression {
        return this.parseBinaryTier(BinaryTier.ADDITIVE);
    }

    parseMultiplicative(): Expression {
        return this.parseBinaryTier(BinaryTier.MULTIPLICATIVE);
    }

    // Left-associative binary parsing for one precedence tier; the tier below it supplies the operands.
    private parseBinaryTier(tier: BinaryTier): Expression {
        const operators = BINARY_TIERS[tier];
        if (!operators) {
            return this.parser.expressions.parseUnary();
        }

        let left = this.parseBinaryTier(tier + 1);

        while (!this.parser.state.eof()) {
            const token = this.parser.state.peek();

            // Inside a template argument list these close the list instead of acting as operators.
            if (this.parser.state.templateAngleDepth > 0 && TEMPLATE_LIST_CLOSERS.has(token.kind)) {
                break;
            }

            const operator = operators[token.kind];
            if (operator === undefined) {
                break;
            }

            this.parser.state.next();
            left = {
                kind: AstKind.BINARY_OP,
                operator,
                left,
                right: this.parseBinaryTier(tier + 1),
                span: left.span,
            };
        }

        return left;
    }

    parseUnary(): Expression {
        const tok = this.parser.state.peek();
        // Reject heap operations once, then skip the rest of the statement.
        if ((tok.kind === TokenKind.IDENTIFIER && tok.text === "new") || tok.kind === TokenKind.KW_DELETE) {
            this.parser.state.diagnostics.push({
                severity: DiagnosticSeverity.ERROR,
                message: `dynamic memory allocation ('${tok.text}') is not allowed in a contract`,
                span: tok.span,
            });
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.SEMICOLON && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
                this.parser.state.next();
            }
            return { kind: AstKind.INT_LITERAL, value: "0", span: tok.span };
        }
        // Prefix operators
        if (
            tok.kind === TokenKind.BANG ||
            tok.kind === TokenKind.TILDE ||
            tok.kind === TokenKind.MINUS ||
            tok.kind === TokenKind.PLUS ||
            tok.kind === TokenKind.STAR ||
            tok.kind === TokenKind.AMP
        ) {
            const opMap: Record<string, UnaryOp> = {
                bang: UnaryOp.LOGICAL_NOT,
                tilde: UnaryOp.BITWISE_NOT,
                minus: UnaryOp.MINUS,
                plus: UnaryOp.PLUS,
                star: UnaryOp.DEREFERENCE,
                amp: UnaryOp.ADDRESS_OF,
            };
            const operator = opMap[tok.kind];
            if (operator) {
                this.parser.state.next();
                const argument = this.parser.expressions.parseUnary();
                return { kind: AstKind.UNARY_OP, operator, argument, span: tok.span };
            }
        }
        // Prefix ++ / --
        if (tok.kind === TokenKind.PLUS_PLUS || tok.kind === TokenKind.MINUS_MINUS) {
            const operator = tok.kind === TokenKind.PLUS_PLUS ? UpdateOp.INCREMENT : UpdateOp.DECREMENT;
            this.parser.state.next();
            const argument = this.parser.expressions.parseUnary();
            return { kind: AstKind.PREFIX_OP, operator, argument, span: tok.span };
        }
        // sizeof
        if (tok.kind === TokenKind.KW_SIZEOF) {
            return this.parser.types.parseSizeof();
        }
        // Cast: (type)expr
        if (tok.kind === TokenKind.L_PAREN && this.parser.types.isTypeCast()) {
            return this.parser.types.parseCast();
        }
        return this.parser.expressions.parsePostfix();
    }

    parsePostfix(): Expression {
        let expression = this.parser.expressions.parsePrimaryExpression();
        while (!this.parser.state.eof()) {
            const tok = this.parser.state.peek();
            // Parse brace initialization only when the prefix names a type.
            if (tok.kind === TokenKind.L_BRACE && (expression.kind === AstKind.IDENTIFIER || expression.kind === AstKind.QUALIFIED_NAME)) {
                const name = expression.kind === AstKind.IDENTIFIER ? expression.name : `${expression.namespace}::${expression.name}`;
                this.parser.state.next(); // {
                const callArguments: Expression[] = [];
                while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
                    callArguments.push(this.parser.expressions.parseBraceArg());
                    if (!this.parser.state.tryConsume(TokenKind.COMMA)) break;
                }
                this.parser.state.expect(TokenKind.R_BRACE, "brace init");
                expression = {
                    kind: AstKind.CONSTRUCT,
                    type: { kind: AstKind.NAME, name },
                    callArguments,
                    span: expression.span,
                };
                continue;
            }
            // .member or ->member
            if (tok.kind === TokenKind.DOT || tok.kind === TokenKind.ARROW) {
                const arrow = tok.kind === TokenKind.ARROW;
                this.parser.state.next();
                const memberTok = this.parser.state.expect(TokenKind.IDENTIFIER, "member access");
                if (memberTok) {
                    expression = {
                        kind: AstKind.MEMBER_ACCESS,
                        object: expression,
                        member: memberTok.text,
                        arrow,
                        span: expression.span,
                    };
                }
                continue;
            }
            // [index] (internal/QPI framework use)
            if (tok.kind === TokenKind.L_BRACKET) {
                this.parser.state.next();
                const index = this.parser.expressions.parseExpression();
                this.parser.state.expect(TokenKind.R_BRACKET, "subscript");
                expression = {
                    kind: AstKind.SUBSCRIPT,
                    object: expression,
                    index,
                    span: expression.span,
                };
                continue;
            }
            // Function call: expr(args)
            if (tok.kind === TokenKind.L_PAREN) {
                this.parser.state.next();
                const callArguments = this.parser.expressions.parseArgList();
                this.parser.state.expect(TokenKind.R_PAREN, "call args");
                expression = {
                    kind: AstKind.CALL,
                    callee: expression,
                    callArguments,
                    span: expression.span,
                };
                continue;
            }
            // Template call: expr<T>(args) — only when the lookahead genuinely matches `< types > (`.
            if (tok.kind === TokenKind.L_ANGLE && this.parser.expressions.looksLikeTemplateArgs()) {
                this.parser.state.next();
                const templateArguments: TypeSpec[] = [];
                while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_ANGLE) {
                    const argStart = this.parser.state.peek().span;
                    const kind = this.parser.state.peek().kind;
                    // Preserve value arguments in function templates such as `irootK64<2>`.
                    if (
                        kind === TokenKind.INT_LITERAL ||
                        kind === TokenKind.L_PAREN ||
                        kind === TokenKind.KW_SIZEOF ||
                        kind === TokenKind.CHAR_LITERAL ||
                        kind === TokenKind.MINUS ||
                        kind === TokenKind.TILDE ||
                        kind === TokenKind.KW_TRUE ||
                        kind === TokenKind.KW_FALSE ||
                        this.parser.types.templateArgIsExpr()
                    ) {
                        templateArguments.push({
                            kind: AstKind.EXPR_VALUE,
                            expression: this.parser.expressions.parseShift(),
                            span: argStart,
                        });
                    } else {
                        templateArguments.push(this.parser.types.parseTypeSpec());
                    }
                    if (!this.parser.state.tryConsume(TokenKind.COMMA)) break;
                }
                this.parser.state.consumeTemplateAngleClose();
                this.parser.state.expect(TokenKind.L_PAREN, "template call args");
                const callArguments = this.parser.expressions.parseArgList();
                this.parser.state.expect(TokenKind.R_PAREN, "template call args close");
                expression = {
                    kind: AstKind.TEMPLATE_CALL,
                    callee: expression,
                    templateArguments,
                    callArguments,
                    span: expression.span,
                };
                continue;
            }
            // Postfix ++ / --
            if (tok.kind === TokenKind.PLUS_PLUS || tok.kind === TokenKind.MINUS_MINUS) {
                const operator = tok.kind === TokenKind.PLUS_PLUS ? UpdateOp.INCREMENT : UpdateOp.DECREMENT;
                this.parser.state.next();
                expression = {
                    kind: AstKind.POSTFIX_OP,
                    operator,
                    argument: expression,
                    span: expression.span,
                };
                continue;
            }
            break;
        }
        return expression;
    }

    looksLikeTemplateArgs(): boolean {
        const save = this.parser.state.position;
        this.parser.state.next(); // consume `<`
        let depth = 1;
        let ok = true;
        let guard = 0;
        while (!this.parser.state.eof() && depth > 0 && guard++ < 200) {
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
            // Tokens that can't appear inside a template-argument list → it's a comparison.
            if (
                kind === TokenKind.SEMICOLON ||
                kind === TokenKind.L_BRACE ||
                kind === TokenKind.R_BRACE ||
                kind === TokenKind.EQ ||
                kind === TokenKind.PLUS ||
                kind === TokenKind.MINUS ||
                kind === TokenKind.SLASH ||
                kind === TokenKind.PERCENT ||
                kind === TokenKind.QUESTION ||
                kind === TokenKind.AMP_AMP ||
                kind === TokenKind.PIPE_PIPE ||
                kind === TokenKind.EQ_EQ ||
                kind === TokenKind.NOT_EQ ||
                kind === TokenKind.L_PAREN ||
                kind === TokenKind.R_PAREN
            ) {
                ok = false;
                break;
            }
            this.parser.state.next();
        }
        const followedByParen = ok && depth <= 0 && this.parser.state.peek().kind === TokenKind.L_PAREN;
        this.parser.state.position = save;
        return followedByParen;
    }

    parseBraceArg(): Expression {
        if (this.parser.state.peek().kind === TokenKind.L_BRACE) {
            const start = this.parser.state.next().span; // {
            const expressions: Expression[] = [];
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
                expressions.push(this.parser.expressions.parseBraceArg());
                if (!this.parser.state.tryConsume(TokenKind.COMMA)) break;
            }
            this.parser.state.expect(TokenKind.R_BRACE, "initializer list");
            return { kind: AstKind.INITIALIZER_LIST, expressions, span: start };
        }
        return this.parser.expressions.parseExpression();
    }

    parsePrimaryExpression(): Expression {
        const tok = this.parser.state.peek();
        // Literals
        if (tok.kind === TokenKind.INT_LITERAL) {
            this.parser.state.next();
            // Split the u/l suffix off the digits — literal typing (width/signedness) reads it.
            const member = tok.text.match(/^(.+?)([uUlL]+)$/);
            if (member) {
                return {
                    kind: AstKind.INT_LITERAL,
                    value: member[1],
                    suffix: member[2],
                    span: tok.span,
                };
            }
            return { kind: AstKind.INT_LITERAL, value: tok.text, span: tok.span };
        }
        if (tok.kind === TokenKind.FLOAT_LITERAL) {
            this.parser.state.next();
            return { kind: AstKind.FLOAT_LITERAL, value: tok.text, span: tok.span };
        }
        if (tok.kind === TokenKind.STRING_LITERAL) {
            this.parser.state.next();
            // Adjacent string literals concatenate (C++ rule): static_assert(c, #fn "_locals too large").
            let value = tok.text.replace(/"/g, "");
            while (this.parser.state.peek().kind === TokenKind.STRING_LITERAL) {
                value += this.parser.state.next().text.replace(/"/g, "");
            }
            return { kind: AstKind.STRING_LITERAL, value, span: tok.span };
        }
        if (tok.kind === TokenKind.CHAR_LITERAL) {
            this.parser.state.next();
            return {
                kind: AstKind.CHAR_LITERAL,
                value: this.parser.recovery.parseCharValue(tok.text),
                span: tok.span,
            };
        }
        if (tok.kind === TokenKind.KW_TRUE) {
            this.parser.state.next();
            return { kind: AstKind.BOOL_LITERAL, value: true, span: tok.span };
        }
        if (tok.kind === TokenKind.KW_FALSE) {
            this.parser.state.next();
            return { kind: AstKind.BOOL_LITERAL, value: false, span: tok.span };
        }
        if (tok.kind === TokenKind.KW_NULLPTR) {
            this.parser.state.next();
            return { kind: AstKind.NULLPTR_LITERAL, span: tok.span };
        }
        // this
        if (tok.kind === TokenKind.KW_THIS) {
            this.parser.state.next();
            return { kind: AstKind.THIS, span: tok.span };
        }
        // Parenthesized expression
        if (tok.kind === TokenKind.L_PAREN) {
            this.parser.state.next();
            const savedGt = this.parser.state.templateAngleDepth;
            this.parser.state.templateAngleDepth = 0; // a `>` inside parens is a comparison again, even within a template list
            const expression = this.parser.expressions.parseExpression();
            this.parser.state.templateAngleDepth = savedGt;
            this.parser.state.expect(TokenKind.R_PAREN, "paren expr");
            return { kind: AstKind.PAREN, expression, span: tok.span };
        }
        // Brace initializer: {a, b, c}
        if (tok.kind === TokenKind.L_BRACE) {
            this.parser.state.next();
            const savedGt = this.parser.state.templateAngleDepth;
            this.parser.state.templateAngleDepth = 0;
            const expressions: Expression[] = [];
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== TokenKind.R_BRACE) {
                expressions.push(this.parser.expressions.parseExpression());
                if (!this.parser.state.tryConsume(TokenKind.COMMA)) break;
            }
            this.parser.state.templateAngleDepth = savedGt;
            this.parser.state.expect(TokenKind.R_BRACE, "initializer list");
            return { kind: AstKind.INITIALIZER_LIST, expressions, span: tok.span };
        }
        // Identifier or qualified name
        const name = this.parser.types.parseQualifiedName();
        if (name) {
            return { kind: AstKind.IDENTIFIER, name, span: tok.span };
        }
        // Error recovery
        this.parser.state.diagnostics.push({
            severity: DiagnosticSeverity.ERROR,
            message: `Expected expression but got ${tok.kind} (${tok.text})`,
            span: tok.span,
        });
        this.parser.state.next();
        return { kind: AstKind.INT_LITERAL, value: "0", span: tok.span };
    }

    parseCommaSequence(): Expression {
        const first = this.parser.expressions.parseExpression();
        if (this.parser.state.peek().kind !== TokenKind.COMMA) return first;
        const expressions = [first];
        while (this.parser.state.peek().kind === TokenKind.COMMA) {
            this.parser.state.next();
            expressions.push(this.parser.expressions.parseExpression());
        }
        return { kind: AstKind.SEQUENCE, expressions, span: first.span };
    }

    looksLikeLocalDecl(): boolean {
        const t0 = this.parser.state.peek().kind;
        if (t0 === TokenKind.KW_CONST || t0 === TokenKind.KW_AUTO) return true;
        if (t0 !== TokenKind.IDENTIFIER) return false;
        // Skip a qualified type name: identifier (:: identifier)* — e.g. QPI::uint64 name.
        let index = 1;
        while (this.parser.state.peek(index).kind === TokenKind.D_COLON && this.parser.state.peek(index + 1).kind === TokenKind.IDENTIFIER) index += 2;
        // Skip template arguments `<...>` so `ProposalWithAllVoteData<D, N>& p` is recognized as a decl, not read as a `<`
        if (this.parser.state.peek(index).kind === TokenKind.L_ANGLE) {
            let depth = 0;
            let templateEndIndex = index;
            for (; !this.parser.state.eof(); templateEndIndex++) {
                const kind = this.parser.state.peek(templateEndIndex).kind;
                if (kind === TokenKind.L_ANGLE) depth++;
                else if (kind === TokenKind.R_ANGLE) {
                    if (--depth === 0) {
                        templateEndIndex++;
                        break;
                    }
                } else if (kind === TokenKind.R_SHIFT) {
                    depth -= 2;
                    if (depth <= 0) {
                        templateEndIndex++;
                        break;
                    }
                } else if (kind === TokenKind.SEMICOLON || kind === TokenKind.L_BRACE || kind === TokenKind.R_BRACE || kind === TokenKind.R_PAREN) return false;
            }
            if (depth > 0) return false;
            index = templateEndIndex;
        }
        const t1 = this.parser.state.peek(index).kind;
        if (t1 === TokenKind.IDENTIFIER) return true;
        if ((t1 === TokenKind.STAR || t1 === TokenKind.AMP) && this.parser.state.peek(index + 1).kind === TokenKind.IDENTIFIER) return true;
        return false;
    }

    parseArgList(): Expression[] {
        const callArguments: Expression[] = [];
        if (this.parser.state.peek().kind === TokenKind.R_PAREN) {
            return callArguments;
        }
        while (!this.parser.state.eof()) {
            callArguments.push(this.parser.expressions.parseExpression());
            if (!this.parser.state.tryConsume(TokenKind.COMMA)) {
                break;
            }
        }
        return callArguments;
    }
}
