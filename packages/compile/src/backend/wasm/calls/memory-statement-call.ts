import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";

const QPI_MEMORY_WRAPPERS = new Set([
    "setMemory",
    "copyMemory",
    "copyFromBuffer",
    "copyToBuffer",
]);

export function tryEmitMemoryStatementCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (expression.callee.kind !== "identifier") {
        return false;
    }

    if (QPI_MEMORY_WRAPPERS.has(expression.callee.name)) {
        emitQpiMemoryWrapper(context, expression, expression.callee.name);
        return true;
    }

    if (expression.callee.name === "copyMem" || expression.callee.name === "setMem") {
        emitRawMemoryIntrinsic(context, expression, expression.callee.name);
        return true;
    }

    return false;
}

function emitQpiMemoryWrapper(
    context: FunctionEmissionContext,
    expression: CallExpression,
    callName: string,
): void {
    const destinationExpression = expression.callArguments[0];
    const destinationResolution = destinationExpression
        ? context.lowering.resolveExpressionAddress(context, destinationExpression)
        : null;
    const destinationAddress =
        destinationResolution?.addr ??
        (destinationExpression
            ? (context.lowering.emitAddress(context, destinationExpression) ?? "(i32.const 0)")
            : "(i32.const 0)");

    if (callName === "setMemory") {
        const value = expression.callArguments[1]
            ? context.lowering.lowerValueExpression(context, expression.callArguments[1])
            : watIr.i64Constant(0);
        const setCall = watIr.functionCall(
            "$setMem",
            addrIr(destinationAddress),
            watIr.i32Constant(destinationResolution?.size ?? 0),
            watIr.operation("i32.wrap_i64", value),
        );
        context.lines.push(`    ${watIr.serializeWatNode(setCall)}`);
        return;
    }

    const sourceExpression = expression.callArguments[1];
    const sourceResolution = sourceExpression
        ? context.lowering.resolveExpressionAddress(context, sourceExpression)
        : null;
    const sourceAddress =
        sourceResolution?.addr ??
        (sourceExpression
            ? (context.lowering.emitAddress(context, sourceExpression) ?? "(i32.const 0)")
            : "(i32.const 0)");
    const copySize =
        callName === "copyToBuffer"
            ? (sourceResolution?.size ?? 0)
            : (destinationResolution?.size ?? 0);
    const copyCall = watIr.functionCall(
        "$copyMem",
        addrIr(destinationAddress),
        addrIr(sourceAddress),
        watIr.i32Constant(copySize),
    );

    context.lines.push(`    ${watIr.serializeWatNode(copyCall)}`);
}

function emitRawMemoryIntrinsic(
    context: FunctionEmissionContext,
    expression: CallExpression,
    callName: string,
): void {
    const destinationAddress = expression.callArguments[0]
        ? (context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)")
        : "(i32.const 0)";

    if (callName === "copyMem") {
        const sourceAddress = expression.callArguments[1]
            ? (context.lowering.emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)")
            : "(i32.const 0)";
        const copyCall = watIr.functionCall(
            "$copyMem",
            addrIr(destinationAddress),
            addrIr(sourceAddress),
            wrapCallArgument(context, expression.callArguments[2]),
        );
        context.lines.push(`    ${watIr.serializeWatNode(copyCall)}`);
        return;
    }

    const setCall = watIr.functionCall(
        "$setMem",
        addrIr(destinationAddress),
        wrapCallArgument(context, expression.callArguments[1]),
        wrapCallArgument(context, expression.callArguments[2]),
    );
    context.lines.push(`    ${watIr.serializeWatNode(setCall)}`);
}

function wrapCallArgument(
    context: FunctionEmissionContext,
    expression: Expression | undefined,
): watIr.WatNode {
    const value = expression
        ? context.lowering.lowerValueExpression(context, expression)
        : watIr.i64Constant(0);
    return watIr.operation("i32.wrap_i64", value);
}
