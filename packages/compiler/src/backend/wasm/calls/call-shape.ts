import { AstKind } from "../../../shared/enums";
import type { Expression } from "../../../ast";
import type { FunctionEmissionContext } from "../types";

// Return the method name for `qpi(aggregate).method(...)` wrappers.
export function qpiWrapperMethod(
    expression: Expression & {
        kind: AstKind.CALL;
    },
): string | null {
    const callee = expression.callee;
    if (callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const object = callee.object;
    if (object.kind === AstKind.CALL && object.callee.kind === AstKind.IDENTIFIER && object.callee.name === "qpi") return callee.member;
    return null;
}

export function describeShape(expression: Expression): string {
    if (!expression) return "?";
    if (expression.kind === AstKind.IDENTIFIER) return expression.name;
    if (expression.kind === AstKind.MEMBER_ACCESS) return `${describeShape(expression.object)}.${expression.member}`;
    if (expression.kind === AstKind.CALL) return `${describeShape(expression.callee)}(${expression.callArguments.length})`;
    if (expression.kind === AstKind.SUBSCRIPT) return `${describeShape(expression.object)}[]`;
    return expression.kind;
}

// the address a call argument names; a missing or unaddressable one is refused, since address 0 is real memory.
export function argumentAddress(context: FunctionEmissionContext, call: Expression & { kind: AstKind.CALL }, index: number): string {
    const argument = call.callArguments[index];
    const address = argument ? context.lowering.emitAddress(context, argument) : null;

    if (!address) {
        throw new Error(`argument ${index + 1} of ${describeShape(call)} is not addressable`);
    }

    return address;
}
