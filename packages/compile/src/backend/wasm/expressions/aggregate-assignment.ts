import { AssignOp, AstKind, ContainerEmissionMode } from "../../../enums";
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
        expression.operator !== AssignOp.ASSIGN ||
        !context.lowering.isAggregate(context, target.type, target.size)
    ) {
        return false;
    }

    if (tryEmitAssetIteratorAssignment(context, expression, target)) {
        return true;
    }

    if (
        expression.right.kind === AstKind.CONSTRUCT &&
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
        expression.right.kind === AstKind.INITIALIZER_LIST &&
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
        target.type?.kind !== AstKind.NAME ||
        !/Asset(Ownership|Possession)Iterator$/.test(target.type.name) ||
        (expression.right.kind !== AstKind.CALL && expression.right.kind !== AstKind.CONSTRUCT) ||
        (expression.right.kind === AstKind.CALL &&
            (expression.right.callee.kind !== AstKind.IDENTIFIER ||
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
                kind: AstKind.CALL,
                span: expression.span,
                callArguments: [assetExpression],
                callee: {
                    kind: AstKind.MEMBER_ACCESS,
                    span: expression.span,
                    object: expression.left,
                    member: "begin",
                },
            } as Expression & { kind: AstKind.CALL },
            ContainerEmissionMode.STATEMENT,
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
