// Passing a wasm-local scalar by mutable reference.
//
// A scalar that lives in a wasm local has no address, so a `T&` parameter cannot point at it. The
// backend spills it to scratch and passes that — which is correct only if the copy is read back after
// the call, or the callee's write is lost.
//
// That read-back existed in exactly one call path and for exactly one storage kind, which is how F221
// survived being "fixed": the container/`this` path wrote back body locals, so `DateAndTime::add`
// looked right, while a contract's own `static void bump(uint64& slot, ...)` went through the helper
// path and dropped every write. Both paths and both storage kinds live here now, so the next call path
// that needs it borrows the rule instead of re-deriving half of it.
import { AstKind, UnaryOp, WatNodeType } from "../../../shared/enums";
import type { Expression } from "../../../ast";
import { FunctionEmissionContext } from "../types";
import * as watIr from "../wat-ir";

/**
 * Whether `name` is a scalar held in a wasm local — a body local, or a by-value parameter. Those are
 * the storage kinds with no address; an address-passed parameter already has one to hand out.
 */
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

/**
 * Spill an argument that names a wasm-local scalar into scratch so a mutable reference can point at it.
 *
 * Returns the scratch address to pass and the line that copies the result back, which the caller must
 * emit *after* the call. Returns null when the argument is not a wasm-local scalar — it either has a
 * real address already, or it is not an lvalue at all and no write-back is meaningful.
 */
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

/**
 * Whether a compiled parameter is a mutable reference to a scalar — the case that needs the spill.
 *
 * `isAddr` is set for a pointer, a mutable reference, *or* an aggregate passed by address, and the
 * declared type here is already dereferenced. A scalar that is nonetheless passed by address can only
 * be the reference case: a `const T&` to a scalar is passed by value and never sets `isAddr`.
 */
export function isMutableScalarReference(context: FunctionEmissionContext, parameter: { isAddr: boolean; type: Expression | unknown }): boolean {
    const declared = parameter.type as Parameters<FunctionEmissionContext["programAnalysis"]["isAggregateType"]>[0];
    if (!parameter.isAddr) return false;
    if (context.programAnalysis.isAggregateType(declared)) return false;
    return context.programAnalysis.sizeOfType(declared) <= 8;
}
