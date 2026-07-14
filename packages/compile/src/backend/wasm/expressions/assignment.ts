import { describeShape } from "../calls/call-shape";
import type { FunctionEmissionContext } from "../types";
import { tryEmitAggregateAssignment } from "./aggregate-assignment";
import {
    compoundToBinary,
    narrowLocalValue,
    newValueTmp,
} from "./assignment-helpers";
import type { AssignmentExpression } from "./assignment-types";
import { tryEmitScalarAssignment } from "./scalar-assignment";
import { tryEmitTestHarnessAssignment } from "./test-harness-assignment";
import { tryEmitUint128Assignment } from "./uint128-assignment";

export { compoundToBinary, narrowLocalValue, newValueTmp } from "./assignment-helpers";
export type { AssignmentExpression, AssignmentTarget } from "./assignment-types";

export function emitAssignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
): void {
    if (tryEmitTestHarnessAssignment(context, expression)) {
        return;
    }

    const target = context.lowering.resolveExpressionAddress(context, expression.left);

    if (tryEmitUint128Assignment(context, expression, target)) {
        return;
    }

    if (tryEmitAggregateAssignment(context, expression, target)) {
        return;
    }

    if (tryEmitScalarAssignment(context, expression, target)) {
        return;
    }

    context.programAnalysis.warn(
        `unsupported assignment target [${describeShape(expression.left)}]`,
        expression.span.line,
    );
}

// Compatibility export for callers that still expect discarded-expression text.
export function emitAssign(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
): string {
    emitAssignment(context, expression);
    return "";
}
