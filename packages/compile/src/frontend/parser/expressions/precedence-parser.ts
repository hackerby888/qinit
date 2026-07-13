import type { AssignOp, BinaryOp, Expression } from "../../../ast";
import type { ParserInternals } from "../parser-context";

export function parseExpression(context: ParserInternals): Expression {
    return context.parseAssignment();
}

export function parseAssignment(context: ParserInternals): Expression {
    const left = context.parseTernary();
    const tok = context.peek();
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
        context.next();
        const right = context.parseAssignment();
        return { kind: "assign", operator, left, right, span: left.span };
    }
    return left;
}

export function parseTernary(context: ParserInternals): Expression {
    const condition = context.parseLogicalOr();
    if (context.tryConsume("question")) {
        const then = context.parseExpression();
        context.expect("colon", "ternary");
        const else_ = context.parseExpression();
        return { kind: "ternary", condition, then, else_, span: condition.span };
    }
    return condition;
}

export function parseLogicalOr(context: ParserInternals): Expression {
    let left = context.parseLogicalAnd();
    while (context.tryConsume("pipe_pipe")) {
        const right = context.parseLogicalAnd();
        left = { kind: "binary_op", operator: "||", left, right, span: left.span };
    }
    return left;
}

export function parseLogicalAnd(context: ParserInternals): Expression {
    let left = context.parseBitwiseOr();
    while (context.tryConsume("amp_amp")) {
        const right = context.parseBitwiseOr();
        left = { kind: "binary_op", operator: "&&", left, right, span: left.span };
    }
    return left;
}

export function parseBitwiseOr(context: ParserInternals): Expression {
    let left = context.parseBitwiseXor();
    while (context.tryConsume("pipe")) {
        const right = context.parseBitwiseXor();
        left = { kind: "binary_op", operator: "|", left, right, span: left.span };
    }
    return left;
}

export function parseBitwiseXor(context: ParserInternals): Expression {
    let left = context.parseBitwiseAnd();
    while (context.tryConsume("caret")) {
        const right = context.parseBitwiseAnd();
        left = { kind: "binary_op", operator: "^", left, right, span: left.span };
    }
    return left;
}

export function parseBitwiseAnd(context: ParserInternals): Expression {
    let left = context.parseEquality();
    while (context.tryConsume("amp")) {
        const right = context.parseEquality();
        left = { kind: "binary_op", operator: "&", left, right, span: left.span };
    }
    return left;
}

export function parseEquality(context: ParserInternals): Expression {
    let left = context.parseComparison();
    while (!context.eof()) {
        const tok = context.peek();
        if (tok.kind === "eq_eq") {
            context.next();
            left = {
                kind: "binary_op",
                operator: "==",
                left,
                right: context.parseComparison(),
                span: left.span,
            };
        }
        else if (tok.kind === "not_eq") {
            context.next();
            left = {
                kind: "binary_op",
                operator: "!=",
                left,
                right: context.parseComparison(),
                span: left.span,
            };
        }
        else {
            break;
        }
    }
    return left;
}

export function parseComparison(context: ParserInternals): Expression {
    let left = context.parseShift();
    while (!context.eof()) {
        const tok = context.peek();
        // `<` / `>` lex as l_angle / r_angle (shared with template brackets). At this precedence level
        const ops: Record<string, BinaryOp> = {
            l_angle: "<",
            r_angle: ">",
            lt_eq: "<=",
            gt_eq: ">=",
        };
        // Inside a template arg/param list a top-level `>` / `>=` closes the list, not a comparison.
        if (context.gtDisabled > 0 && (tok.kind === "r_angle" || tok.kind === "gt_eq")) {
            break;
        }
        const operator = ops[tok.kind];
        if (operator) {
            context.next();
            left = { kind: "binary_op", operator, left, right: context.parseShift(), span: left.span };
        }
        else if (tok.kind === "spaceship") {
            // <=> — treat as comparison
            context.next();
            left = { kind: "binary_op", operator: "<", left, right: context.parseShift(), span: left.span };
        }
        else {
            break;
        }
    }
    return left;
}

export function parseShift(context: ParserInternals): Expression {
    let left = context.parseAdditive();
    while (!context.eof()) {
        if (context.gtDisabled > 0 && context.peek().kind === "r_shift") {
            break; // `>>` closes two nested template lists here, not a shift operator
        }
        if (context.tryConsume("l_shift")) {
            left = { kind: "binary_op", operator: "<<", left, right: context.parseAdditive(), span: left.span };
        }
        else if (context.tryConsume("r_shift")) {
            left = { kind: "binary_op", operator: ">>", left, right: context.parseAdditive(), span: left.span };
        }
        else {
            break;
        }
    }
    return left;
}

export function parseAdditive(context: ParserInternals): Expression {
    let left = context.parseMultiplicative();
    while (!context.eof()) {
        if (context.tryConsume("plus")) {
            left = {
                kind: "binary_op",
                operator: "+",
                left,
                right: context.parseMultiplicative(),
                span: left.span,
            };
        }
        else if (context.tryConsume("minus")) {
            left = {
                kind: "binary_op",
                operator: "-",
                left,
                right: context.parseMultiplicative(),
                span: left.span,
            };
        }
        else {
            break;
        }
    }
    return left;
}

export function parseMultiplicative(context: ParserInternals): Expression {
    let left = context.parseUnary();
    while (!context.eof()) {
        if (context.tryConsume("star")) {
            left = { kind: "binary_op", operator: "*", left, right: context.parseUnary(), span: left.span };
        }
        else if (context.tryConsume("slash")) {
            left = { kind: "binary_op", operator: "/", left, right: context.parseUnary(), span: left.span };
        }
        else if (context.tryConsume("percent")) {
            left = { kind: "binary_op", operator: "%", left, right: context.parseUnary(), span: left.span };
        }
        else {
            break;
        }
    }
    return left;
}
