import { AstKind, LogPayloadDefect, UnaryOp, WatNodeType } from "../../../shared/enums";
import { QUBIC_LOG_TYPE } from "@qinit/proto";
import type { Expression } from "../../../ast";
import * as watIr from "../wat-ir";
import { LOG_TERMINATOR_FIELD, logPayloadDefect, logPayloadMessage } from "../abi/log-payload";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";

const LOG_LEVELS: Readonly<Record<string, number>> = {
    __qinit_log_error: QUBIC_LOG_TYPE.CONTRACT_ERROR_MESSAGE,
    __qinit_log_warning: QUBIC_LOG_TYPE.CONTRACT_WARNING_MESSAGE,
    __qinit_log_info: QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE,
    __qinit_log_debug: QUBIC_LOG_TYPE.CONTRACT_DEBUG_MESSAGE,
};

export function tryEmitHostIntrinsicCall(context: FunctionEmissionContext, expression: CallExpression): boolean {
    if (expression.callee.kind !== AstKind.IDENTIFIER) {
        return false;
    }

    if (expression.callee.name === "KangarooTwelve") {
        emitKangarooTwelveCall(context, expression);
        return true;
    }

    if (expression.callee.name.startsWith("__qinit_log_")) {
        emitLoggingCall(context, expression);
        return true;
    }

    return false;
}

function emitKangarooTwelveCall(context: FunctionEmissionContext, expression: CallExpression): void {
    const inputAddress = expression.callArguments[0]
        ? (context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)")
        : "(i32.const 0)";
    const inputSize = expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
    const digestAddress = context.lowering.allocateScratchSlotNode(context, 32);

    context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$lh_k12", addrIr(inputAddress), watIr.operation("i32.wrap_i64", inputSize), digestAddress))}`,
    );

    let outputExpression: Expression | undefined = expression.callArguments[2];
    while (outputExpression?.kind === AstKind.PAREN || (outputExpression?.kind === AstKind.UNARY_OP && outputExpression.operator === UnaryOp.ADDRESS_OF)) {
        outputExpression = outputExpression.kind === AstKind.PAREN ? outputExpression.expression : outputExpression.argument;
    }

    if (outputExpression?.kind === AstKind.IDENTIFIER && context.localVars.get(outputExpression.name)?.wasmType === WatNodeType.I64) {
        context.lines.push(`    ${context.lowering.setLocal(context, outputExpression.name, watIr.rawLoad("i64.load", null, digestAddress))}`);
        return;
    }

    const outputAddress = expression.callArguments[2] ? context.lowering.emitAddress(context, expression.callArguments[2]) : null;

    if (!outputAddress) {
        throw new Error("KangarooTwelve output is not addressable");
    }

    const outputSize = expression.callArguments[3] ? context.lowering.lowerValueExpression(context, expression.callArguments[3]) : watIr.i64Constant(32);

    context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(outputAddress), digestAddress, watIr.operation("i32.wrap_i64", outputSize)))}`,
    );
}

function emitLoggingCall(context: FunctionEmissionContext, expression: CallExpression): void {
    const callName = expression.callee.kind === AstKind.IDENTIFIER ? expression.callee.name : "";
    const logLevel = LOG_LEVELS[callName];

    if (logLevel !== undefined) {
        emitLogMessage(context, expression, callName, logLevel);
        return;
    }

    if (callName === "__qinit_log_pause") {
        context.lines.push("    (call $lh_pauseLog)");
        return;
    }

    if (callName === "__qinit_log_resume") {
        context.lines.push("    (call $lh_resumeLog)");
        return;
    }

    throw new Error(`unknown logging intrinsic '${callName}'`);
}

function emitLogMessage(context: FunctionEmissionContext, expression: CallExpression, callName: string, logLevel: number): void {
    const argument = expression.callArguments[0];
    const payload = argument ? context.lowering.resolveExpressionAddress(context, argument) : null;
    // Report rather than throw, so the diagnostic carries a source location and the remaining
    // functions still get emitted. The module is discarded either way once an error is present.
    const span = argument?.span ?? expression.span;

    if (!payload) {
        context.programAnalysis.error(`${callName} payload must be an addressable aggregate`, span);
        return;
    }

    if (!payload.layout) {
        context.programAnalysis.error(logPayloadMessage(callName, LogPayloadDefect.NOT_A_STRUCT), span);
        return;
    }

    const defect = logPayloadDefect(payload.layout);

    if (defect) {
        context.programAnalysis.error(logPayloadMessage(callName, defect), span);
        return;
    }

    const terminator = payload.layout.fields.get(LOG_TERMINATOR_FIELD)!;
    const payloadAddress = addrIr(payload.addr);
    const loggingCall = watIr.functionCall(
        "$qpi_logBytes",
        watIr.i32Constant(context.programAnalysis.slot),
        watIr.i32Constant(logLevel),
        payloadAddress,
        watIr.i32Constant(terminator.offset),
    );

    context.lines.push(`    ${watIr.serializeWatNode(loggingCall)}`);
    // Restore the host-stamped contract index so logging cannot alter contract state.
    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, payloadAddress, watIr.i32Constant(0)))}`);
}
