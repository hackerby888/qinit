import { AstKind } from "../../../enums";
import type { Expression } from "../../../ast";

// Return the method name for `qpi(aggregate).method(...)` wrappers.
export function qpiWrapperMethod(expression: Expression & {
    kind: AstKind.CALL;
}): string | null {
    const callee = expression.callee;
    if (callee.kind !== AstKind.MEMBER_ACCESS)
        return null;
    const object = callee.object;
    if (object.kind === AstKind.CALL && object.callee.kind === AstKind.IDENTIFIER && object.callee.name === "qpi")
        return callee.member;
    return null;
}

export function describeShape(expression: Expression): string {
    if (!expression)
        return "?";
    if (expression.kind === AstKind.IDENTIFIER)
        return expression.name;
    if (expression.kind === AstKind.MEMBER_ACCESS)
        return `${describeShape(expression.object)}.${expression.member}`;
    if (expression.kind === AstKind.CALL)
        return `${describeShape(expression.callee)}(${expression.callArguments.length})`;
    if (expression.kind === AstKind.SUBSCRIPT)
        return `${describeShape(expression.object)}[]`;
    return expression.kind;
}
