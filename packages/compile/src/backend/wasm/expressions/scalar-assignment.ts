import * as watIr from "../../../wat-ir";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import { compoundToBinary, narrowLocalValue } from "./assignment-helpers";
import type { AssignmentExpression, AssignmentTarget } from "./assignment-types";

export function tryEmitScalarAssignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
    target: AssignmentTarget | null,
): boolean {
    if (target) {
        emitScalarMemoryAssignment(context, expression, target);
        return true;
    }

    if (
        expression.left.kind !== "identifier" ||
        !context.lowering.isScalarLocal(context, expression.left.name)
    ) {
        return false;
    }

    const localName = expression.left.name;
    const assignedValue = lowerAssignedValue(context, expression);
    context.lines.push(
        `    ${context.lowering.setLocal(
            context,
            localName,
            narrowLocalValue(context, localName, assignedValue),
        )}`,
    );
    return true;
}

function emitScalarMemoryAssignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
    target: AssignmentTarget,
): void {
    const assignedValue = lowerAssignedValue(context, expression);
    const store = watIr.storeScalar(addrIr(target.addr), target.size, assignedValue);
    context.lines.push(`    ${watIr.serializeWatNode(store)}`);
}

function lowerAssignedValue(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
): watIr.WatNode {
    const valueExpression =
        expression.operator === "=" ? expression.right : compoundToBinary(expression);
    return context.lowering.lowerValueExpression(context, valueExpression);
}
