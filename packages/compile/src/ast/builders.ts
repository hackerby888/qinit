import type { Declaration } from "./declarations";
import type { BinaryOp, Expression } from "./expressions";
import type { Statement } from "./statements";
import type { Span } from "./source-location";
import type { TypeSpec } from "./types";

// ---- Helper constructors (for codegen tests and WAT emission) ----
export function nameType(name: string): TypeSpec {
    return { kind: "name", name };
}

export function templateInstance(name: string, callArguments: TypeSpec[]): TypeSpec {
    return { kind: "template_instance", name, callArguments };
}

export function id(name: string, span?: Span): Expression {
    return { kind: "identifier", name, span: span ?? { start: 0, end: 0, line: 0, column: 0 } };
}

export function member(obj: Expression, memberName: string, arrow?: boolean): Expression {
    return { kind: "member_access", object: obj, member: memberName, arrow: !!arrow, span: obj.span };
}

export function call(callee: Expression, callArguments: Expression[]): Expression {
    return { kind: "call", callee, callArguments, span: callee.span ?? { start: 0, end: 0, line: 0, column: 0 } };
}

export function intLit(value: string, suffix?: string): Expression {
    return { kind: "int_literal", value, suffix, span: { start: 0, end: 0, line: 0, column: 0 } };
}

export function binary(left: Expression, operator: BinaryOp, right: Expression): Expression {
    return { kind: "binary_op", operator, left, right, span: left.span };
}

export function retStmt(value?: Expression): Statement {
    return { kind: "return", value, span: { start: 0, end: 0, line: 0, column: 0 } };
}

export function exprStmt(expression: Expression): Statement {
    return { kind: "expression", expression, span: expression.span };
}

export function declStmt(declaration: Declaration): Statement {
    return { kind: "declaration", declaration, span: declaration.span ?? { start: 0, end: 0, line: 0, column: 0 } };
}
