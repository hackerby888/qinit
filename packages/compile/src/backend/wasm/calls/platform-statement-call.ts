import { AstKind, PlatformPrimitiveKind } from "../../../enums";
import * as watIr from "../../../wat-ir";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";
import { platformPrimitive } from "./platform-primitives";

export function tryEmitPlatformStatementCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (expression.callee.kind === AstKind.IDENTIFIER && expression.callee.name === "ASSERT") {
        return true;
    }

    const primitive =
        expression.callee.kind === AstKind.IDENTIFIER || expression.callee.kind === AstKind.QUALIFIED_NAME
            ? platformPrimitive(expression.callee.name)
            : undefined;

    if (primitive?.kind === PlatformPrimitiveKind.MEMORY_STORE) {
        const destinationAddress = context.lowering.emitAddress(
            context,
            expression.callArguments[0],
        );
        const sourceAddress = context.lowering.emitAddress(
            context,
            expression.callArguments[1],
        );

        if (!destinationAddress || !sourceAddress) {
            throw new Error(`${primitive.name} operands must be addressable`);
        }

        const copyCall = watIr.functionCall(
            "$copyMem",
            addrIr(destinationAddress),
            addrIr(sourceAddress),
            watIr.i32Constant(32),
        );
        context.lines.push(`    ${watIr.serializeWatNode(copyCall)}`);
        return true;
    }

    if (primitive?.kind === PlatformPrimitiveKind.CHAIN_RDRAND) {
        const randomValue = context.lowering.emitCallValueIr(context, expression);
        context.lines.push(
            `    ${watIr.serializeWatNode(watIr.operation("drop", randomValue))}`,
        );
        return true;
    }

    return false;
}
