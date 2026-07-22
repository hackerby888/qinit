import type { Expression } from "../../../ast";

// Return the method name for `qpi(aggregate).method(...)` wrappers.
export function qpiWrapperMethod(expression: Expression & {
    kind: "call";
}): string | null {
    const callee = expression.callee;
    if (callee.kind !== "member_access")
        return null;
    const object = callee.object;
    if (object.kind === "call" && object.callee.kind === "identifier" && object.callee.name === "qpi")
        return callee.member;
    return null;
}

export function describeShape(expression: Expression): string {
    if (!expression)
        return "?";
    if (expression.kind === "identifier")
        return expression.name;
    if (expression.kind === "member_access")
        return `${describeShape(expression.object)}.${expression.member}`;
    if (expression.kind === "call")
        return `${describeShape(expression.callee)}(${expression.callArguments.length})`;
    if (expression.kind === "subscript")
        return `${describeShape(expression.object)}[]`;
    return expression.kind;
}
