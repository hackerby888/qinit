import { AstKind } from "../../../enums";
import { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
// statement call: a container mutation or a side-effecting qpi host call.
export function emitInterContract(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.CALL;
}, isInvoke: boolean): string | null {
    const calleeArg = expression.callArguments[0];
    const functionArg = expression.callArguments[1];
    if (calleeArg?.kind !== AstKind.IDENTIFIER || functionArg?.kind !== AstKind.IDENTIFIER)
        return null;
    const callee = context.programAnalysis.callees.get(calleeArg.name);
    let idx: number | null = callee?.index ?? null;
    if (idx === null) {
        const resolvedConstant = context.programAnalysis.resolveConst(`${calleeArg.name}_CONTRACT_INDEX`);
        if (resolvedConstant !== null)
            idx = Number(resolvedConstant);
    }
    const entry = isInvoke ? callee?.procedures[functionArg.name] : callee?.functions[functionArg.name];
    if (idx === null || !entry)
        return null;
    if (!expression.callArguments[2] || !expression.callArguments[3])
        throw new Error(`${isInvoke ? "INVOKE" : "CALL"}_OTHER requires input and output buffers`);
    const inAddr = context.lowering.emitAddress(context, expression.callArguments[2]);
    const outAddr = context.lowering.emitAddress(context, expression.callArguments[3]);
    if (!inAddr || !outAddr)
        throw new Error(`${isInvoke ? "INVOKE" : "CALL"}_OTHER input and output must be addressable`);
    const inSize = (expression.callArguments[2] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[2])?.size : undefined) ?? entry.inSize;
    const outSize = (expression.callArguments[3] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[3])?.size : undefined) ?? entry.outSize;
    const dims = `(i32.const ${idx}) (i32.const ${entry.inputType}) ${inAddr} (i32.const ${inSize}) ${outAddr} (i32.const ${outSize})`;
    // Return the i32 error result; statement callers drop it.
    if (isInvoke) {
        const reward = expression.callArguments[4] ? context.lowering.emitValue(context, expression.callArguments[4]) : "(i64.const 0)";
        return `(call $liteInvokeProcedure ${dims} ${reward})`;
    }
    return `(call $liteCallFunction ${dims})`;
}
