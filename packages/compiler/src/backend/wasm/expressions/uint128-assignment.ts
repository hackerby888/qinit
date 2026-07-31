import { AssignOp } from "../../../enums";
import * as watIr from "../../../wat-ir";
import { isUint128 } from "../memory/address-resolution";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import { compoundToBinary } from "./assignment-helpers";
import type { AssignmentExpression, AssignmentTarget } from "./assignment-types";

export function tryEmitUint128Assignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
    target: AssignmentTarget | null,
): boolean {
    if (!target || !isUint128(context.programAnalysis, target.type)) {
        return false;
    }

    const sourceAddress =
        expression.operator === AssignOp.ASSIGN
            ? context.lowering.lowerUint128Expression(context, expression.right)
            : context.lowering.lowerUint128Expression(
                  context,
                  compoundToBinary(expression),
              );
    const copyCall = watIr.functionCall(
        "$copyMem",
        addrIr(target.addr),
        sourceAddress,
        watIr.i32Constant(16),
    );

    context.lines.push(`    ${watIr.serializeWatNode(copyCall)}`);
    return true;
}
