import { describeShape } from "../calls/call-shape";
import type { FunctionEmissionContext } from "../types";
import { tryEmitAggregateAssignment } from "./aggregate-assignment";
import type { AssignmentExpression } from "./assignment-types";
import { tryEmitScalarAssignment } from "./scalar-assignment";
import { tryEmitOverloadedAssignment } from "./overloaded-assignment";
import { tryEmitUint128Assignment } from "./uint128-assignment";

export { compoundToBinary, narrowLocalValue, newValueTmp } from "./assignment-helpers";
export type { AssignmentExpression, AssignmentTarget } from "./assignment-types";

// describeShape marks a call with its argument count, `state.mut(0)`; a message shows the target as it was written.
function targetSpelling(expression: AssignmentExpression): string {
    return describeShape(expression.left).replace(/\(\d+\)/g, "()");
}

export function emitAssignment(context: FunctionEmissionContext, expression: AssignmentExpression): void {
    const target = context.lowering.resolveExpressionAddress(context, expression.left);
    if (target?.readOnly) {
        context.programAnalysis.error(`cannot assign to read-only '${targetSpelling(expression)}': ${target.readOnly}`, expression.span);
        return;
    }

    if (tryEmitUint128Assignment(context, expression, target)) {
        return;
    }

    if (tryEmitOverloadedAssignment(context, expression, target)) {
        return;
    }

    if (tryEmitAggregateAssignment(context, expression, target)) {
        return;
    }

    if (tryEmitScalarAssignment(context, expression, target)) {
        return;
    }

    context.programAnalysis.warn(`unsupported assignment target [${targetSpelling(expression)}]`, expression.left.span ?? expression.span);
}
