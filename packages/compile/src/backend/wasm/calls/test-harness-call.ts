import type { Expression, TypeSpec } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { addrIr } from "../memory/memory-operations";
import { EMPTY_TEMPLATE_BINDINGS, type FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";
import { describeShape } from "./call-shape";

const ASSERTION_OPERATIONS = ["eq", "ne", "lt", "le", "gt", "ge", "true", "false"];

export function tryEmitTestHarnessCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): boolean {
    if (!context.programAnalysis.gtestMode || expression.callee.kind !== "identifier") {
        return false;
    }

    const callName = expression.callee.name;

    if (
        callName === "__qtest_noop" ||
        callName === "initEmptySpectrum" ||
        callName === "initEmptyUniverse"
    ) {
        return true;
    }

    if (callName === "invokeUserProcedure") {
        emitTestProcedureInvocation(context, expression);
        return true;
    }

    if (callName === "callFunction") {
        emitTestFunctionQuery(context, expression);
        return true;
    }

    if (callName === "increaseEnergy") {
        emitTestEnergyIncrease(context, expression);
        return true;
    }

    if (callName === "callSystemProcedure") {
        emitTestSystemProcedureCall(context, expression);
        return true;
    }

    return tryEmitTestAssertion(context, expression, callName);
}

function emitTestProcedureInvocation(
    context: FunctionEmissionContext,
    expression: CallExpression,
): void {
    const input = expression.callArguments[2]
        ? context.lowering.resolveExpressionAddress(context, expression.callArguments[2])
        : null;
    const output = expression.callArguments[3]
        ? context.lowering.resolveExpressionAddress(context, expression.callArguments[3])
        : null;
    const origin = expression.callArguments[4]
        ? context.lowering.emitAddress(context, expression.callArguments[4])
        : null;

    if (!input || !output || !origin) {
        throw new Error("gtest invokeUserProcedure requires addressable input, output, and origin");
    }

    const contractSlot = watIr.operation(
        "i32.wrap_i64",
        context.lowering.lowerValueExpression(context, expression.callArguments[0]),
    );
    const inputType = watIr.operation(
        "i32.wrap_i64",
        context.lowering.lowerValueExpression(context, expression.callArguments[1]),
    );
    const reward = expression.callArguments[5]
        ? context.lowering.lowerValueExpression(context, expression.callArguments[5])
        : watIr.i64Constant(0);
    const invocation = watIr.functionCall(
        "$qt_invoke",
        contractSlot,
        inputType,
        addrIr(input.addr),
        watIr.i32Constant(input.size),
        addrIr(output.addr),
        reward,
        addrIr(origin),
    );

    context.lines.push(
        `    ${watIr.serializeWatNode(watIr.operation("drop", invocation))}`,
    );
}

function emitTestFunctionQuery(
    context: FunctionEmissionContext,
    expression: CallExpression,
): void {
    let input = expression.callArguments[2]
        ? context.lowering.resolveExpressionAddress(context, expression.callArguments[2])
        : null;
    const output = expression.callArguments[3]
        ? context.lowering.resolveExpressionAddress(context, expression.callArguments[3])
        : null;

    if (!input && expression.callArguments[2]) {
        const inputExpression = expression.callArguments[2];
        const inputAddress = context.lowering.emitAddress(context, inputExpression);
        const constructorName =
            inputExpression.kind === "call" &&
            (inputExpression.callee.kind === "identifier" ||
                inputExpression.callee.kind === "qualified_name")
                ? inputExpression.callee.name
                : null;
        const inputType: TypeSpec | null = constructorName
            ? { kind: "name", name: constructorName }
            : null;
        const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
        const inputSize = inputType
            ? context.programAnalysis.sizeOfType(inputType, templateBindings)
            : 0;

        if (inputAddress && inputType) {
            input = {
                addr: inputAddress,
                type: inputType,
                size: inputSize,
                layout: context.programAnalysis.layoutOfType(inputType, templateBindings),
            };
        }
    }

    if (!input || !output) {
        throw new Error(
            `gtest callFunction requires addressable input and output (${describeShape(expression.callArguments[2])}, ${describeShape(expression.callArguments[3])})`,
        );
    }

    const contractSlot = watIr.operation(
        "i32.wrap_i64",
        context.lowering.lowerValueExpression(context, expression.callArguments[0]),
    );
    const inputType = watIr.operation(
        "i32.wrap_i64",
        context.lowering.lowerValueExpression(context, expression.callArguments[1]),
    );
    const query = watIr.functionCall(
        "$qt_query",
        contractSlot,
        inputType,
        addrIr(input.addr),
        watIr.i32Constant(input.size),
        addrIr(output.addr),
        watIr.i32Constant(output.size),
    );

    context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", query))}`);
}

function emitTestEnergyIncrease(
    context: FunctionEmissionContext,
    expression: CallExpression,
): void {
    const accountAddress = expression.callArguments[0]
        ? context.lowering.emitAddress(context, expression.callArguments[0])
        : null;

    if (!accountAddress) {
        throw new Error("gtest increaseEnergy account must be addressable");
    }

    const amount = expression.callArguments[1]
        ? context.lowering.lowerValueExpression(context, expression.callArguments[1])
        : watIr.i64Constant(0);
    const fundingCall = watIr.functionCall("$qt_fund", addrIr(accountAddress), amount);

    context.lines.push(`    ${watIr.serializeWatNode(fundingCall)}`);
}

function emitTestSystemProcedureCall(
    context: FunctionEmissionContext,
    expression: CallExpression,
): void {
    const contractSlot = watIr.operation(
        "i32.wrap_i64",
        expression.callArguments[0]
            ? context.lowering.lowerValueExpression(context, expression.callArguments[0])
            : watIr.i64Constant(0),
    );
    const procedureId = watIr.operation(
        "i32.wrap_i64",
        expression.callArguments[1]
            ? context.lowering.lowerValueExpression(context, expression.callArguments[1])
            : watIr.i64Constant(0),
    );
    const procedureCall = watIr.functionCall("$qt_system", contractSlot, procedureId);

    context.lines.push(
        `    ${watIr.serializeWatNode(watIr.operation("drop", procedureCall))}`,
    );
}

function tryEmitTestAssertion(
    context: FunctionEmissionContext,
    expression: CallExpression,
    callName: string,
): boolean {
    const assertion = callName.match(
        /^__qtest_(expect|assert)_(eq|ne|lt|le|gt|ge|true|false)$/,
    );

    if (!assertion) {
        return false;
    }

    const fatal = assertion[1] === "assert";
    const operation = assertion[2];
    const zero = (): Expression => ({
        kind: "int_literal",
        value: "0",
        span: expression.span,
    });
    const left = expression.callArguments[0] ?? zero();
    const right =
        operation === "true" || operation === "false"
            ? zero()
            : (expression.callArguments[1] ?? zero());
    const comparisonOperators = {
        eq: "==",
        ne: "!=",
        lt: "<",
        le: "<=",
        gt: ">",
        ge: ">=",
    } as const;
    const operator =
        operation === "true"
            ? "!="
            : operation === "false"
              ? "=="
              : comparisonOperators[operation as keyof typeof comparisonOperators];
    const comparison = context.lowering.lowerValueExpression(context, {
        kind: "binary_op",
        operator,
        left,
        right,
        span: expression.span,
    });
    const assertionCode = ASSERTION_OPERATIONS.indexOf(operation);

    context.lines.push(`    (if (i64.eqz ${watIr.serializeWatNode(comparison)}) (then`);
    context.lines.push(
        `      ${watIr.serializeWatNode(
            watIr.functionCall(
                "$qt_fail",
                watIr.i32Constant(assertionCode),
                watIr.i32Constant(fatal ? 1 : 0),
            ),
        )}`,
    );

    if (fatal) {
        context.lines.push("      (return)");
    }

    context.lines.push("    ))");
    return true;
}
