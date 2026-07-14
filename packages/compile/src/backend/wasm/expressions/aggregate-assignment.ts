import { describeShape } from "../calls/call-shape";
import { addrIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import type { AssignmentExpression, AssignmentTarget } from "./assignment-types";

export function tryEmitAggregateAssignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
    target: AssignmentTarget | null,
): boolean {
    if (
        !target ||
        expression.operator !== "=" ||
        !context.lowering.isAggregate(context, target.type, target.size)
    ) {
        return false;
    }

    if (tryEmitAssetIteratorAssignment(context, expression, target)) {
        return true;
    }

    if (
        expression.right.kind === "construct" &&
        target.type &&
        context.lowering.emitConstruct(
            context,
            target.addr,
            target.type,
            expression.right.callArguments,
        )
    ) {
        return true;
    }

    if (
        expression.right.kind === "initializer_list" &&
        target.type &&
        context.lowering.emitConstruct(
            context,
            target.addr,
            target.type,
            expression.right.expressions,
        )
    ) {
        return true;
    }

    const sourceAddress = context.lowering.emitAddress(context, expression.right);
    if (sourceAddress) {
        const copyCall = watIr.functionCall(
            "$copyMem",
            addrIr(target.addr),
            addrIr(sourceAddress),
            watIr.i32Constant(target.size),
        );
        context.lines.push(`    ${watIr.serializeWatNode(copyCall)}`);
        return true;
    }

    context.programAnalysis.warn(
        `unsupported aggregate assignment [${describeShape(expression.left)} = ${describeShape(expression.right)}]`,
        expression.span.line,
    );
    return true;
}

function tryEmitAssetIteratorAssignment(
    context: FunctionEmissionContext,
    expression: AssignmentExpression,
    target: AssignmentTarget,
): boolean {
    if (
        target.type?.kind !== "name" ||
        !/Asset(Ownership|Possession)Iterator$/.test(target.type.name) ||
        (expression.right.kind !== "call" && expression.right.kind !== "construct") ||
        (expression.right.kind === "call" &&
            (expression.right.callee.kind !== "identifier" ||
                !/Asset(Ownership|Possession)Iterator$/.test(
                    expression.right.callee.name,
                )))
    ) {
        return false;
    }

    const assetExpression = expression.right.callArguments[0];
    if (assetExpression) {
        context.lowering.emitAssetIter(
            context,
            {
                kind: "call",
                span: expression.span,
                callArguments: [assetExpression],
                callee: {
                    kind: "member_access",
                    span: expression.span,
                    object: expression.left,
                    member: "begin",
                },
            } as Expression & { kind: "call" },
            "stmt",
        );
    } else {
        const clearIterator = watIr.rawStore(
            "i64.store",
            null,
            addrIr(target.addr),
            watIr.i64Constant(0),
        );
        context.lines.push(`    ${watIr.serializeWatNode(clearIterator)}`);
    }

    return true;
}
