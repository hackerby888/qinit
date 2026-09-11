// A scalar in a wasm local has no address, so a `T&` parameter gets a scratch copy — correct only if
// the copy is read back after the call. Shared here so every call path applies the same rule.
import { AstKind, UnaryOp, WatNodeType } from "../../../shared/enums";
import type { Expression } from "../../../ast";
import { FunctionEmissionContext } from "../types";
import * as watIr from "../wat-ir";

/** Whether `name` is a scalar in a wasm local — a body local or by-value parameter. Those have no
 *  address; an address-passed parameter already has one to hand out. */
export function isScalarValueSlot(context: FunctionEmissionContext, name: string): boolean {
    if (context.localVars.get(name)?.wasmType === WatNodeType.I64) return true;
    const parameter = context.params?.get(name);
    return !!parameter && !parameter.isAddr && parameter.wasmType === WatNodeType.I64;
}

/** `&x` and `(x)` reach the same storage as a bare `x`. */
function underlyingLvalue(expression: Expression): Expression {
    let source = expression;
    while (source.kind === AstKind.PAREN || (source.kind === AstKind.UNARY_OP && source.operator === UnaryOp.ADDRESS_OF)) {
        source = source.kind === AstKind.PAREN ? source.expression : source.argument;
    }
    return source;
}

/** Spill a wasm-local scalar to scratch so a mutable reference can point at it. Returns the address to
 *  pass and the write-back line, which the caller must emit after the call; null when it has an address. */
export function spillForMutableReference(context: FunctionEmissionContext, argument: Expression): { addr: string; writeBack: string } | null {
    const source = underlyingLvalue(argument);
    if (source.kind !== AstKind.IDENTIFIER || !isScalarValueSlot(context, source.name)) return null;

    const slot = context.lowering.allocateScratchSlotNode(context, 8);
    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, slot, context.lowering.lowerValueExpression(context, source)))}`);
    return {
        addr: watIr.serializeWatNode(slot),
        writeBack: `    ${context.lowering.setLocal(context, source.name, watIr.rawLoad("i64.load", null, slot))}`,
    };
}

/** Whether a parameter is a mutable reference to a scalar — the case needing a spill. A scalar passed by
 *  address can only be that: a `const T&` to a scalar goes by value and never sets `isAddr`. */
export function isMutableScalarReference(context: FunctionEmissionContext, parameter: { isAddr: boolean; type: Expression | unknown }): boolean {
    const declared = parameter.type as Parameters<FunctionEmissionContext["programAnalysis"]["isAggregateType"]>[0];
    if (!parameter.isAddr) return false;
    if (context.programAnalysis.isAggregateType(declared)) return false;
    return context.programAnalysis.sizeOfType(declared) <= 8;
}
