import type { FunctionEmissionContext } from "../types";
import type { CallExpression } from "./call-expression";
import { describeShape } from "./call-shape";
import { tryEmitContractStatementCall } from "./contract-statement-call";
import { tryEmitHostIntrinsicCall } from "./host-intrinsic-call";
import { tryEmitMemoryStatementCall } from "./memory-statement-call";
import { tryEmitPlatformStatementCall } from "./platform-statement-call";
import * as watIr from "../wat-ir";

export function emitCallStatement(context: FunctionEmissionContext, expression: CallExpression): void {
    if (tryEmitHostIntrinsicCall(context, expression)) {
        return;
    }

    if (tryEmitPlatformStatementCall(context, expression)) {
        return;
    }

    if (tryEmitContractStatementCall(context, expression)) {
        return;
    }

    if (tryEmitMemoryStatementCall(context, expression)) {
        return;
    }

    if (tryEmitExistingSpecializedCall(context, expression)) {
        return;
    }

    const unbound = context.lowering.emitQpiCall(context, expression);
    if (unbound) {
        context.lines.push(`    ${watIr.serializeWatNode(unbound)}`);
        return;
    }
    context.programAnalysis.warn(`unsupported call statement [${describeShape(expression)}]`, expression.span.line);
}

function tryEmitExistingSpecializedCall(context: FunctionEmissionContext, expression: CallExpression): boolean {
    const emittedThisCall = context.lowering.emitThisCall(context, expression, false);
    if (emittedThisCall !== null) {
        return true;
    }

    const emittedHelperCall = context.lowering.emitHelperCall(context, expression, false);
    if (emittedHelperCall !== null) {
        return true;
    }

    const emittedContainerCall = context.lowering.emitContainerCall(context, expression, false);
    return emittedContainerCall !== null;
}
