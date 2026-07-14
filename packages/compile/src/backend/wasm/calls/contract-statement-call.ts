import * as watIr from "../../../wat-ir";
import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";
import { qpiWrapperMethod } from "./call-shape";

export function tryEmitContractStatementCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (
        expression.callee.kind === "member_access" &&
        context.lowering.emitInlineStructStatement(context, expression)
    ) {
        return true;
    }

    if (
        context.proxyClass &&
        context.lowering.emitProxySiblingCall(context, expression, false) !== null
    ) {
        return true;
    }

    const proxyMethod = qpiWrapperMethod(expression);
    if (proxyMethod) {
        if (context.lowering.emitProposalProxyCall(context, expression, false) === null) {
            throw new Error(`authoritative proposal method '${proxyMethod}' could not be lowered`);
        }
        return true;
    }

    if (context.lowering.emitAssetIter(context, expression, "stmt") !== null) {
        return true;
    }

    if (tryEmitSelfContractCall(context, expression)) {
        return true;
    }

    if (tryEmitDirectContractCall(context, expression)) {
        return true;
    }

    return tryEmitInterContractCall(context, expression);
}

function tryEmitSelfContractCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (
        expression.callee.kind !== "identifier" ||
        expression.callee.name !== "__qpi_call_self"
    ) {
        return false;
    }

    const functionArgument = expression.callArguments[0];
    const callableRegistration =
        functionArgument?.kind === "identifier"
            ? (context.programAnalysis.privates.get(functionArgument.name) ??
              context.programAnalysis.registered.get(functionArgument.name))
            : undefined;

    if (!callableRegistration) {
        return false;
    }

    const inputAddress = expression.callArguments[1]
        ? (context.lowering.emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)")
        : "(i32.const 0)";
    const outputAddress = expression.callArguments[2]
        ? (context.lowering.emitAddress(context, expression.callArguments[2]) ?? "(i32.const 0)")
        : "(i32.const 0)";
    const localsAddress = `(call $qpiAllocLocals (i32.const ${callableRegistration.localsSize}))`;

    context.lines.push(
        `    (call ${callableRegistration.label} (global.get $ctxBase) (global.get $stateBase) ${inputAddress} ${outputAddress} ${localsAddress})`,
    );
    return true;
}

function tryEmitDirectContractCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (
        expression.callee.kind !== "identifier" ||
        expression.callArguments[0]?.kind !== "identifier" ||
        expression.callArguments[0].name !== "qpi"
    ) {
        return false;
    }

    const callableRegistration =
        context.programAnalysis.privates.get(expression.callee.name) ??
        context.programAnalysis.registered.get(expression.callee.name);

    if (!callableRegistration) {
        return false;
    }

    const inputAddress = expression.callArguments[2]
        ? (context.lowering.emitAddress(context, expression.callArguments[2]) ?? "(i32.const 0)")
        : "(i32.const 0)";
    const outputAddress = expression.callArguments[3]
        ? (context.lowering.emitAddress(context, expression.callArguments[3]) ?? "(i32.const 0)")
        : "(i32.const 0)";
    const allocatedLocals = `(call $qpiAllocLocals (i32.const ${callableRegistration.localsSize}))`;
    const localsAddress = expression.callArguments[4]
        ? (context.lowering.emitAddress(context, expression.callArguments[4]) ?? allocatedLocals)
        : allocatedLocals;

    context.lines.push(
        `    (call ${callableRegistration.label} (global.get $ctxBase) (global.get $stateBase) ${inputAddress} ${outputAddress} ${localsAddress})`,
    );
    return true;
}

function tryEmitInterContractCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (
        expression.callee.kind !== "identifier" ||
        (expression.callee.name !== "__qpi_call_other" &&
            expression.callee.name !== "__qpi_invoke_other")
    ) {
        return false;
    }

    const invokesProcedure = expression.callee.name === "__qpi_invoke_other";
    const interContractCallText = context.lowering.emitInterContract(
        context,
        expression,
        invokesProcedure,
    );

    if (interContractCallText) {
        const interContractCall = watIr.rawWatNode(
            interContractCallText,
            "i32",
            "unconverted: inter-contract call",
        );
        context.lines.push(
            `    ${watIr.serializeWatNode(
                watIr.operation("drop", interContractCall),
            )}`,
        );
    } else {
        const contractName =
            expression.callArguments[0]?.kind === "identifier"
                ? expression.callArguments[0].name
                : "?";
        context.programAnalysis.warn(
            `unsupported inter-contract call to '${contractName}' (no callee IDL)`,
            expression.span.line,
        );
    }

    return true;
}
