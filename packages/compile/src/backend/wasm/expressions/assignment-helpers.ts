import { SCALAR_SIZE } from "../abi/tables";
import { narrowCastIr } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import type { AssignmentExpression } from "./assignment-types";

export function newValueTmp(context: FunctionEmissionContext): string {
    let temporaryName: string;

    do {
        temporaryName = `__qinit_value${context.tmpCount++}`;
    } while (
        context.localVars.has(temporaryName) ||
        context.params?.has(temporaryName)
    );

    context.localVars.set(temporaryName, { wasmType: "i64" });
    return temporaryName;
}

export function compoundToBinary(expression: AssignmentExpression): Expression {
    return {
        kind: "binary_op",
        operator: expression.operator.slice(0, -1),
        left: expression.left,
        right: expression.right,
        span: expression.span,
    } as Expression;
}

export function narrowLocalValue(
    context: FunctionEmissionContext,
    localName: string,
    value: watIr.WatNode,
): watIr.WatNode {
    const declaredType =
        context.localVars.get(localName)?.type ?? context.params?.get(localName)?.type;
    const storageType = declaredType
        ? context.programAnalysis.scalarStorageType(declaredType)
        : undefined;

    if (
        storageType?.kind === "name" &&
        (SCALAR_SIZE[storageType.name] ?? 8) < 8
    ) {
        return narrowCastIr(value, storageType.name);
    }

    return value;
}
