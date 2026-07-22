import type {
    AssignOp,
    BinaryOp,
    Expression,
    TypeSpec,
    UnaryOp,
} from "../../../ast";
import type { Parser } from "../parser";

export class ExpressionParser {
    constructor(private readonly parser: Parser) {}

    parseExpression(): Expression {
        return this.parser.expressions.parseAssignment();
    }

    parseAssignment(): Expression {
        const left = this.parser.expressions.parseTernary();
        const tok = this.parser.state.peek();
        const assignOps: Record<string, AssignOp> = {
            eq: "=",
            plus_eq: "+=",
            minus_eq: "-=",
            star_eq: "*=",
            slash_eq: "/=",
            percent_eq: "%=",
            l_shift_eq: "<<=",
            r_shift_eq: ">>=",
            amp_eq: "&=",
            pipe_eq: "|=",
            caret_eq: "^=",
        };
        const operator = assignOps[tok.kind];
        if (operator) {
            this.parser.state.next();
            const right = this.parser.expressions.parseAssignment();
            return { kind: "assign", operator, left, right, span: left.span };
        }
        return left;
    }

    parseTernary(): Expression {
        const condition = this.parser.expressions.parseLogicalOr();
        if (this.parser.state.tryConsume("question")) {
            const then = this.parser.expressions.parseExpression();
            this.parser.state.expect("colon", "ternary");
            const else_ = this.parser.expressions.parseExpression();
            return { kind: "ternary", condition, then, else_, span: condition.span };
        }
        return condition;
    }

    parseLogicalOr(): Expression {
        let left = this.parser.expressions.parseLogicalAnd();
        while (this.parser.state.tryConsume("pipe_pipe")) {
            const right = this.parser.expressions.parseLogicalAnd();
            left = { kind: "binary_op", operator: "||", left, right, span: left.span };
        }
        return left;
    }

    parseLogicalAnd(): Expression {
        let left = this.parser.expressions.parseBitwiseOr();
        while (this.parser.state.tryConsume("amp_amp")) {
            const right = this.parser.expressions.parseBitwiseOr();
            left = { kind: "binary_op", operator: "&&", left, right, span: left.span };
        }
        return left;
    }

    parseBitwiseOr(): Expression {
        let left = this.parser.expressions.parseBitwiseXor();
        while (this.parser.state.tryConsume("pipe")) {
            const right = this.parser.expressions.parseBitwiseXor();
            left = { kind: "binary_op", operator: "|", left, right, span: left.span };
        }
        return left;
    }

    parseBitwiseXor(): Expression {
        let left = this.parser.expressions.parseBitwiseAnd();
        while (this.parser.state.tryConsume("caret")) {
            const right = this.parser.expressions.parseBitwiseAnd();
            left = { kind: "binary_op", operator: "^", left, right, span: left.span };
        }
        return left;
    }

    parseBitwiseAnd(): Expression {
        let left = this.parser.expressions.parseEquality();
        while (this.parser.state.tryConsume("amp")) {
            const right = this.parser.expressions.parseEquality();
            left = { kind: "binary_op", operator: "&", left, right, span: left.span };
        }
        return left;
    }

    parseEquality(): Expression {
        let left = this.parser.expressions.parseComparison();
        while (!this.parser.state.eof()) {
            const tok = this.parser.state.peek();
            if (tok.kind === "eq_eq") {
                this.parser.state.next();
                left = {
                    kind: "binary_op",
                    operator: "==",
                    left,
                    right: this.parser.expressions.parseComparison(),
                    span: left.span,
                };
            }
            else if (tok.kind === "not_eq") {
                this.parser.state.next();
                left = {
                    kind: "binary_op",
                    operator: "!=",
                    left,
                    right: this.parser.expressions.parseComparison(),
                    span: left.span,
                };
            }
            else {
                break;
            }
        }
        return left;
    }

    parseComparison(): Expression {
        let left = this.parser.expressions.parseShift();
        while (!this.parser.state.eof()) {
            const tok = this.parser.state.peek();
            // At comparison precedence, angle-bracket tokens are relational operators.
            const ops: Record<string, BinaryOp> = {
                l_angle: "<",
                r_angle: ">",
                lt_eq: "<=",
                gt_eq: ">=",
            };
            // Inside a template arg/param list a top-level `>` / `>=` closes the list, not a comparison.
            if (this.parser.state.templateAngleDepth > 0 && (tok.kind === "r_angle" || tok.kind === "gt_eq")) {
                break;
            }
            const operator = ops[tok.kind];
            if (operator) {
                this.parser.state.next();
                left = { kind: "binary_op", operator, left, right: this.parser.expressions.parseShift(), span: left.span };
            }
            else if (tok.kind === "spaceship") {
                // <=> — treat as comparison
                this.parser.state.next();
                left = { kind: "binary_op", operator: "<", left, right: this.parser.expressions.parseShift(), span: left.span };
            }
            else {
                break;
            }
        }
        return left;
    }

    parseShift(): Expression {
        let left = this.parser.expressions.parseAdditive();
        while (!this.parser.state.eof()) {
            if (this.parser.state.templateAngleDepth > 0 && this.parser.state.peek().kind === "r_shift") {
                break; // `>>` closes two nested template lists here, not a shift operator
            }
            if (this.parser.state.tryConsume("l_shift")) {
                left = { kind: "binary_op", operator: "<<", left, right: this.parser.expressions.parseAdditive(), span: left.span };
            }
            else if (this.parser.state.tryConsume("r_shift")) {
                left = { kind: "binary_op", operator: ">>", left, right: this.parser.expressions.parseAdditive(), span: left.span };
            }
            else {
                break;
            }
        }
        return left;
    }

    parseAdditive(): Expression {
        let left = this.parser.expressions.parseMultiplicative();
        while (!this.parser.state.eof()) {
            if (this.parser.state.tryConsume("plus")) {
                left = {
                    kind: "binary_op",
                    operator: "+",
                    left,
                    right: this.parser.expressions.parseMultiplicative(),
                    span: left.span,
                };
            }
            else if (this.parser.state.tryConsume("minus")) {
                left = {
                    kind: "binary_op",
                    operator: "-",
                    left,
                    right: this.parser.expressions.parseMultiplicative(),
                    span: left.span,
                };
            }
            else {
                break;
            }
        }
        return left;
    }

    parseMultiplicative(): Expression {
        let left = this.parser.expressions.parseUnary();
        while (!this.parser.state.eof()) {
            if (this.parser.state.tryConsume("star")) {
                left = { kind: "binary_op", operator: "*", left, right: this.parser.expressions.parseUnary(), span: left.span };
            }
            else if (this.parser.state.tryConsume("slash")) {
                left = { kind: "binary_op", operator: "/", left, right: this.parser.expressions.parseUnary(), span: left.span };
            }
            else if (this.parser.state.tryConsume("percent")) {
                left = { kind: "binary_op", operator: "%", left, right: this.parser.expressions.parseUnary(), span: left.span };
            }
            else {
                break;
            }
        }
        return left;
    }

    parseUnary(): Expression {
        const tok = this.parser.state.peek();
        // Reject heap operations once, then skip the rest of the statement.
        if ((tok.kind === "identifier" && tok.text === "new") || tok.kind === "kw_delete") {
            this.parser.state.diagnostics.push({
                severity: "error",
                message: `dynamic memory allocation ('${tok.text}') is not allowed in a contract`,
                span: tok.span,
            });
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== "semicolon" && this.parser.state.peek().kind !== "r_brace") {
                this.parser.state.next();
            }
            return { kind: "int_literal", value: "0", span: tok.span };
        }
        // Prefix operators
        if (tok.kind === "bang" ||
            tok.kind === "tilde" ||
            tok.kind === "minus" ||
            tok.kind === "plus" ||
            tok.kind === "star" ||
            tok.kind === "amp") {
            const opMap: Record<string, UnaryOp> = {
                bang: "!",
                tilde: "~",
                minus: "-",
                plus: "+",
                star: "*",
                amp: "&",
            };
            const operator = opMap[tok.kind];
            if (operator) {
                this.parser.state.next();
                const argument = this.parser.expressions.parseUnary();
                return { kind: "unary_op", operator, argument, span: tok.span };
            }
        }
        // Prefix ++ / --
        if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
            const operator = tok.kind === "plus_plus" ? ("++" as const) : ("--" as const);
            this.parser.state.next();
            const argument = this.parser.expressions.parseUnary();
            return { kind: "prefix_op", operator, argument, span: tok.span };
        }
        // sizeof
        if (tok.kind === "kw_sizeof") {
            return this.parser.types.parseSizeof();
        }
        // Cast: (type)expr
        if (tok.kind === "l_paren" && this.parser.types.isTypeCast()) {
            return this.parser.types.parseCast();
        }
        return this.parser.expressions.parsePostfix();
    }

    parsePostfix(): Expression {
        let expression = this.parser.expressions.parsePrimaryExpression();
        while (!this.parser.state.eof()) {
            const tok = this.parser.state.peek();
            // Parse brace initialization only when the prefix names a type.
            if (tok.kind === "l_brace" &&
                (expression.kind === "identifier" || expression.kind === "qualified_name")) {
                const name = expression.kind === "identifier" ? expression.name : `${expression.namespace}::${expression.name}`;
                this.parser.state.next(); // {
                const callArguments: Expression[] = [];
                while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
                    callArguments.push(this.parser.expressions.parseBraceArg());
                    if (!this.parser.state.tryConsume("comma"))
                        break;
                }
                this.parser.state.expect("r_brace", "brace init");
                expression = { kind: "construct", type: { kind: "name", name }, callArguments, span: expression.span };
                continue;
            }
            // .member or ->member
            if (tok.kind === "dot" || tok.kind === "arrow") {
                const arrow = tok.kind === "arrow";
                this.parser.state.next();
                const memberTok = this.parser.state.expect("identifier", "member access");
                if (memberTok) {
                    expression = {
                        kind: "member_access",
                        object: expression,
                        member: memberTok.text,
                        arrow,
                        span: expression.span,
                    };
                }
                continue;
            }
            // [index] (internal/QPI framework use)
            if (tok.kind === "l_bracket") {
                this.parser.state.next();
                const index = this.parser.expressions.parseExpression();
                this.parser.state.expect("r_bracket", "subscript");
                expression = { kind: "subscript", object: expression, index, span: expression.span };
                continue;
            }
            // Function call: expr(args)
            if (tok.kind === "l_paren") {
                this.parser.state.next();
                const callArguments = this.parser.expressions.parseArgList();
                this.parser.state.expect("r_paren", "call args");
                expression = { kind: "call", callee: expression, callArguments, span: expression.span };
                continue;
            }
            // Template call: expr<T>(args) — only when the lookahead genuinely matches `< types > (`.
            if (tok.kind === "l_angle" && this.parser.expressions.looksLikeTemplateArgs()) {
                this.parser.state.next();
                const templateArguments: TypeSpec[] = [];
                while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_angle") {
                    const argStart = this.parser.state.peek().span;
                    const kind = this.parser.state.peek().kind;
                    // Preserve value arguments in function templates such as `irootK64<2>`.
                    if (kind === "int_literal" ||
                        kind === "l_paren" ||
                        kind === "kw_sizeof" ||
                        kind === "char_literal" ||
                        kind === "minus" ||
                        kind === "tilde" ||
                        kind === "kw_true" ||
                        kind === "kw_false" ||
                        this.parser.types.templateArgIsExpr()) {
                        templateArguments.push({ kind: "expr_value", expression: this.parser.expressions.parseShift(), span: argStart });
                    }
                    else {
                        templateArguments.push(this.parser.types.parseTypeSpec());
                    }
                    if (!this.parser.state.tryConsume("comma"))
                        break;
                }
                this.parser.state.consumeTemplateAngleClose();
                this.parser.state.expect("l_paren", "template call args");
                const callArguments = this.parser.expressions.parseArgList();
                this.parser.state.expect("r_paren", "template call args close");
                expression = { kind: "template_call", callee: expression, templateArguments, callArguments, span: expression.span };
                continue;
            }
            // Postfix ++ / --
            if (tok.kind === "plus_plus" || tok.kind === "minus_minus") {
                const operator = tok.kind === "plus_plus" ? ("++" as const) : ("--" as const);
                this.parser.state.next();
                expression = { kind: "postfix_op", operator, argument: expression, span: expression.span };
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
            // Tokens that can't appear inside a template-argument list → it's a comparison.
            if (kind === "semicolon" ||
                kind === "l_brace" ||
                kind === "r_brace" ||
                kind === "eq" ||
                kind === "plus" ||
                kind === "minus" ||
                kind === "slash" ||
                kind === "percent" ||
                kind === "question" ||
                kind === "amp_amp" ||
                kind === "pipe_pipe" ||
                kind === "eq_eq" ||
                kind === "not_eq" ||
                kind === "l_paren" ||
                kind === "r_paren") {
                ok = false;
                break;
            }
            this.parser.state.next();
        }
        const followedByParen = ok && depth <= 0 && this.parser.state.peek().kind === "l_paren";
        this.parser.state.position = save;
        return followedByParen;
    }

    parseBraceArg(): Expression {
        if (this.parser.state.peek().kind === "l_brace") {
            const start = this.parser.state.next().span; // {
            const expressions: Expression[] = [];
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
                expressions.push(this.parser.expressions.parseBraceArg());
                if (!this.parser.state.tryConsume("comma"))
                    break;
            }
            this.parser.state.expect("r_brace", "initializer list");
            return { kind: "initializer_list", expressions, span: start };
        }
        return this.parser.expressions.parseExpression();
    }

    parsePrimaryExpression(): Expression {
        const tok = this.parser.state.peek();
        // Literals
        if (tok.kind === "int_literal") {
            this.parser.state.next();
            // Split the u/l suffix off the digits — literal typing (width/signedness) reads it.
            const member = tok.text.match(/^(.+?)([uUlL]+)$/);
            if (member) {
                return { kind: "int_literal", value: member[1], suffix: member[2], span: tok.span };
            }
            return { kind: "int_literal", value: tok.text, span: tok.span };
        }
        if (tok.kind === "float_literal") {
            this.parser.state.next();
            return { kind: "float_literal", value: tok.text, span: tok.span };
        }
        if (tok.kind === "string_literal") {
            this.parser.state.next();
            // Adjacent string literals concatenate (C++ rule): static_assert(c, #fn "_locals too large").
            let value = tok.text.replace(/"/g, "");
            while (this.parser.state.peek().kind === "string_literal") {
                value += this.parser.state.next().text.replace(/"/g, "");
            }
            return { kind: "string_literal", value, span: tok.span };
        }
        if (tok.kind === "char_literal") {
            this.parser.state.next();
            return { kind: "char_literal", value: this.parser.recovery.parseCharValue(tok.text), span: tok.span };
        }
        if (tok.kind === "kw_true") {
            this.parser.state.next();
            return { kind: "bool_literal", value: true, span: tok.span };
        }
        if (tok.kind === "kw_false") {
            this.parser.state.next();
            return { kind: "bool_literal", value: false, span: tok.span };
        }
        if (tok.kind === "kw_nullptr") {
            this.parser.state.next();
            return { kind: "nullptr_literal", span: tok.span };
        }
        // this
        if (tok.kind === "kw_this") {
            this.parser.state.next();
            return { kind: "this", span: tok.span };
        }
        // Parenthesized expression
        if (tok.kind === "l_paren") {
            this.parser.state.next();
            const savedGt = this.parser.state.templateAngleDepth;
            this.parser.state.templateAngleDepth = 0; // a `>` inside parens is a comparison again, even within a template list
            const expression = this.parser.expressions.parseExpression();
            this.parser.state.templateAngleDepth = savedGt;
            this.parser.state.expect("r_paren", "paren expr");
            return { kind: "paren", expression, span: tok.span };
        }
        // Brace initializer: {a, b, c}
        if (tok.kind === "l_brace") {
            this.parser.state.next();
            const savedGt = this.parser.state.templateAngleDepth;
            this.parser.state.templateAngleDepth = 0;
            const expressions: Expression[] = [];
            while (!this.parser.state.eof() && this.parser.state.peek().kind !== "r_brace") {
                expressions.push(this.parser.expressions.parseExpression());
                if (!this.parser.state.tryConsume("comma"))
                    break;
            }
            this.parser.state.templateAngleDepth = savedGt;
            this.parser.state.expect("r_brace", "initializer list");
            return { kind: "initializer_list", expressions, span: tok.span };
        }
        // Identifier or qualified name
        const name = this.parser.types.parseQualifiedName();
        if (name) {
            return { kind: "identifier", name, span: tok.span };
        }
        // Error recovery
        this.parser.state.diagnostics.push({
            severity: "error",
            message: `Expected expression but got ${tok.kind} (${tok.text})`,
            span: tok.span,
        });
        this.parser.state.next();
        return { kind: "int_literal", value: "0", span: tok.span };
    }

    parseCommaSequence(): Expression {
        const first = this.parser.expressions.parseExpression();
        if (this.parser.state.peek().kind !== "comma")
            return first;
        const expressions = [first];
        while (this.parser.state.peek().kind === "comma") {
            this.parser.state.next();
            expressions.push(this.parser.expressions.parseExpression());
        }
        return { kind: "sequence", expressions, span: first.span };
    }

    looksLikeLocalDecl(): boolean {
        const t0 = this.parser.state.peek().kind;
        if (t0 === "kw_const" || t0 === "kw_auto")
            return true;
        if (t0 !== "identifier")
            return false;
        // Skip a qualified type name: identifier (:: identifier)* — e.g. QPI::uint64 name.
        let index = 1;
        while (this.parser.state.peek(index).kind === "d_colon" && this.parser.state.peek(index + 1).kind === "identifier")
            index += 2;
        // Skip template arguments `<...>` so `ProposalWithAllVoteData<D, N>& p` is recognized as a decl, not read as a `<`
        if (this.parser.state.peek(index).kind === "l_angle") {
            let depth = 0;
            let templateEndIndex = index;
            for (; !this.parser.state.eof(); templateEndIndex++) {
                const kind = this.parser.state.peek(templateEndIndex).kind;
                if (kind === "l_angle")
                    depth++;
                else if (kind === "r_angle") {
                    if (--depth === 0) {
                        templateEndIndex++;
                        break;
                    }
                }
                else if (kind === "r_shift") {
                    depth -= 2;
                    if (depth <= 0) {
                        templateEndIndex++;
                        break;
                    }
                }
                else if (kind === "semicolon" || kind === "l_brace" || kind === "r_brace" || kind === "r_paren")
                    return false;
            }
            if (depth > 0)
                return false;
            index = templateEndIndex;
        }
        const t1 = this.parser.state.peek(index).kind;
        if (t1 === "identifier")
            return true;
        if ((t1 === "star" || t1 === "amp") && this.parser.state.peek(index + 1).kind === "identifier")
            return true;
        return false;
    }

    parseArgList(): Expression[] {
        const callArguments: Expression[] = [];
        if (this.parser.state.peek().kind === "r_paren") {
            return callArguments;
        }
        while (!this.parser.state.eof()) {
            callArguments.push(this.parser.expressions.parseExpression());
            if (!this.parser.state.tryConsume("comma")) {
                break;
            }
        }
        return callArguments;
    }
}
