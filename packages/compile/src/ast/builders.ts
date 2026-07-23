import { AstKind } from "../enums";
import type { Declaration } from "./declarations";
import type { BinaryOp, Expression } from "./expressions";
import type { Statement } from "./statements";
import type { Span } from "./source-location";
import type { TypeSpec } from "./types";

// ---- Helper constructors (for codegen tests and WAT emission) ----
export function nameType(name: string): TypeSpec {
    return { kind: AstKind.NAME, name };
}

export function templateInstance(name: string, callArguments: TypeSpec[]): TypeSpec {
    return { kind: AstKind.TEMPLATE_INSTANCE, name, callArguments };
}

export function id(name: string, span?: Span): Expression {
    return { kind: AstKind.IDENTIFIER, name, span: span ?? { start: 0, end: 0, line: 0, column: 0 } };
}

export function member(obj: Expression, memberName: string, arrow?: boolean): Expression {
    return { kind: AstKind.MEMBER_ACCESS, object: obj, member: memberName, arrow: !!arrow, span: obj.span };
}

export function call(callee: Expression, callArguments: Expression[]): Expression {
    return { kind: AstKind.CALL, callee, callArguments, span: callee.span ?? { start: 0, end: 0, line: 0, column: 0 } };
}

export function intLit(value: string, suffix?: string): Expression {
    return { kind: AstKind.INT_LITERAL, value, suffix, span: { start: 0, end: 0, line: 0, column: 0 } };
}

export function binary(left: Expression, operator: BinaryOp, right: Expression): Expression {
    return { kind: AstKind.BINARY_OP, operator, left, right, span: left.span };
}

export function retStmt(value?: Expression): Statement {
    return { kind: AstKind.RETURN, value, span: { start: 0, end: 0, line: 0, column: 0 } };
}

export function exprStmt(expression: Expression): Statement {
    return { kind: AstKind.EXPRESSION, expression, span: expression.span };
}

export function declStmt(declaration: Declaration): Statement {
    return { kind: AstKind.DECLARATION, declaration, span: declaration.span ?? { start: 0, end: 0, line: 0, column: 0 } };
}
