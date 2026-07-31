import { AssignOp, AstKind } from "../../../enums";
import * as watIr from "../../../wat-ir";
import type { FunctionEmissionContext } from "../types";
import type { AssignmentExpression } from "./assignment-types";

export function tryEmitTestHarnessAssignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
): boolean {
    if (
        !context.programAnalysis.gtestMode ||
        expression.operator !== AssignOp.ASSIGN ||
        expression.left.kind !== AstKind.MEMBER_ACCESS ||
        expression.left.object.kind !== AstKind.IDENTIFIER ||
        expression.left.object.name !== "system" ||
        (expression.left.member !== "epoch" && expression.left.member !== "tick")
    ) {
        return false;
    }

    const hostFunction =
        expression.left.member === "epoch" ? "$qt_set_epoch" : "$qt_set_tick";
    const assignedValue = context.lowering.lowerValueExpression(context, expression.right);
    const hostCall = watIr.functionCall(
        hostFunction,
        watIr.operation("i32.wrap_i64", assignedValue),
    );

    context.lines.push(`    ${watIr.serializeWatNode(hostCall)}`);
    return true;
}
