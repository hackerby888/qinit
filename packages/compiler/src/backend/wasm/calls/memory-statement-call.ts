import { AstKind } from "../../../shared/enums";
import type { Expression } from "../../../ast";
import * as watIr from "../wat-ir";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";
import { argumentAddress, describeShape } from "./call-shape";

const QPI_MEMORY_WRAPPERS = new Set(["setMemory", "copyMemory", "copyFromBuffer", "copyToBuffer"]);

export function tryEmitMemoryStatementCall(context: FunctionEmissionContext, expression: CallExpression): boolean {
    if (expression.callee.kind !== AstKind.IDENTIFIER) {
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

interface WrapperOperand {
    address: string;
    size: number | undefined;
}

// where a wrapper operand lives, and its byte count when its type is known.
function wrapperOperand(context: FunctionEmissionContext, expression: CallExpression, index: number): WrapperOperand {
    const argument = expression.callArguments[index];
    const resolution = argument ? context.lowering.resolveExpressionAddress(context, argument) : null;

    return { address: resolution?.addr ?? argumentAddress(context, expression, index), size: resolution?.size };
}

// a wrapper copies sizeof one operand, so an operand with no known size is refused, never copied as 0 bytes.
function operandSize(expression: CallExpression, operand: WrapperOperand, index: number): number {
    if (operand.size === undefined) {
        throw new Error(`cannot size argument ${index + 1} of ${describeShape(expression)}`);
    }

    return operand.size;
}

function emitQpiMemoryWrapper(context: FunctionEmissionContext, expression: CallExpression, callName: string): void {
    const destination = wrapperOperand(context, expression, 0);

    if (callName === "setMemory") {
        const value = expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
        const setCall = watIr.functionCall(
            "$setMem",
            addrIr(destination.address),
            watIr.i32Constant(operandSize(expression, destination, 0)),
            watIr.operation("i32.wrap_i64", value),
        );
        context.lines.push(`    ${watIr.serializeWatNode(setCall)}`);
        return;
    }

    const source = wrapperOperand(context, expression, 1);
    const copySize = callName === "copyToBuffer" ? operandSize(expression, source, 1) : operandSize(expression, destination, 0);
    const copyCall = watIr.functionCall("$copyMem", addrIr(destination.address), addrIr(source.address), watIr.i32Constant(copySize));

    context.lines.push(`    ${watIr.serializeWatNode(copyCall)}`);

    if (callName === "copyToBuffer" && expression.callArguments[2]) {
        emitTailZeroing(context, expression, destination, copySize);
    }
}

// copyToBuffer(dst, src, setTailToZero): a true flag also zeroes what dst holds past the copy of src.
function emitTailZeroing(context: FunctionEmissionContext, expression: CallExpression, destination: WrapperOperand, copiedBytes: number): void {
    const tailBytes = operandSize(expression, destination, 0) - copiedBytes;
    const setTailToZero = context.lowering.emitValue(context, expression.callArguments[2]);

    if (tailBytes <= 0) {
        return;
    }

    const tailAddress = watIr.operation("i32.add", addrIr(destination.address), watIr.i32Constant(copiedBytes));
    const zeroTail = watIr.functionCall("$setMem", tailAddress, watIr.i32Constant(tailBytes), watIr.i32Constant(0));

    context.lines.push(`    (if (i64.ne (i64.const 0) ${setTailToZero}) (then ${watIr.serializeWatNode(zeroTail)}))`);
}

function emitRawMemoryIntrinsic(context: FunctionEmissionContext, expression: CallExpression, callName: string): void {
    const destinationAddress = argumentAddress(context, expression, 0);

    if (callName === "copyMem") {
        const sourceAddress = argumentAddress(context, expression, 1);
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

function wrapCallArgument(context: FunctionEmissionContext, expression: Expression | undefined): watIr.WatNode {
    const value = expression ? context.lowering.lowerValueExpression(context, expression) : watIr.i64Constant(0);
    return watIr.operation("i32.wrap_i64", value);
}
