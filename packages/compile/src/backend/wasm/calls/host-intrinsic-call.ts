import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";

const LOG_LEVELS: Readonly<Record<string, number>> = {
    __qinit_log_error: 4,
    __qinit_log_warning: 5,
    __qinit_log_info: 6,
    __qinit_log_debug: 7,
};

export function tryEmitHostIntrinsicCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (expression.callee.kind !== "identifier") {
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

function emitKangarooTwelveCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): void {
    const inputAddress = expression.callArguments[0]
        ? (context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)")
        : "(i32.const 0)";
    const inputSize = expression.callArguments[1]
        ? context.lowering.lowerValueExpression(context, expression.callArguments[1])
        : watIr.i64Constant(0);
    const digestAddress = context.lowering.allocateScratchSlotNode(context, 32);

    context.lines.push(
        `    ${watIr.serializeWatNode(
            watIr.functionCall(
                "$lh_k12",
                addrIr(inputAddress),
                watIr.operation("i32.wrap_i64", inputSize),
                digestAddress,
            ),
        )}`,
    );

    let outputExpression: Expression | undefined = expression.callArguments[2];
    while (
        outputExpression?.kind === "paren" ||
        (outputExpression?.kind === "unary_op" && outputExpression.operator === "&")
    ) {
        outputExpression =
            outputExpression.kind === "paren"
                ? outputExpression.expression
                : outputExpression.argument;
    }

    if (
        outputExpression?.kind === "identifier" &&
        context.localVars.get(outputExpression.name)?.wasmType === "i64"
    ) {
        context.lines.push(
            `    ${context.lowering.setLocal(
                context,
                outputExpression.name,
                watIr.rawLoad("i64.load", null, digestAddress),
            )}`,
        );
        return;
    }

    const outputAddress = expression.callArguments[2]
        ? context.lowering.emitAddress(context, expression.callArguments[2])
        : null;

    if (!outputAddress) {
        throw new Error("KangarooTwelve output is not addressable");
    }

    const outputSize = expression.callArguments[3]
        ? context.lowering.lowerValueExpression(context, expression.callArguments[3])
        : watIr.i64Constant(32);

    context.lines.push(
        `    ${watIr.serializeWatNode(
            watIr.functionCall(
                "$copyMem",
                addrIr(outputAddress),
                digestAddress,
                watIr.operation("i32.wrap_i64", outputSize),
            ),
        )}`,
    );
}

function emitLoggingCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): void {
    const callName = expression.callee.kind === "identifier" ? expression.callee.name : "";
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

function emitLogMessage(
    context: FunctionEmissionContext,
    expression: CallExpression,
    callName: string,
    logLevel: number,
): void {
    const payload = expression.callArguments[0]
        ? context.lowering.resolveExpressionAddress(context, expression.callArguments[0])
        : null;

    if (!payload) {
        throw new Error(`${callName} payload must be an addressable aggregate`);
    }

    if (!payload.layout) {
        throw new Error(`${callName} payload must be a struct`);
    }

    const terminator = payload.layout.fields.get("_terminator");
    if (!terminator) {
        throw new Error(`${callName} payload struct must contain _terminator`);
    }

    if (terminator.offset < 8) {
        throw new Error(`${callName} payload _terminator offset must be at least 8 bytes`);
    }

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
    context.lines.push(
        `    ${watIr.serializeWatNode(
            watIr.rawStore("i32.store", null, payloadAddress, watIr.i32Constant(0)),
        )}`,
    );
}
