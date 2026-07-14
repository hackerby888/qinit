import { addrIr, emitScalarLoad, isSignedScalarType, emitScalarStore } from "../memory/memory-operations";
import { isUint128 } from "../memory/address-resolution";
import { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
// Emit an expression used as a statement (side effects only). Calls/assignments push their own
export function emitDiscardedExpression(context: FunctionEmissionContext, expression: Expression): string {
    if (expression.kind === "assign")
        return context.lowering.emitAssign(context, expression);
    if (expression.kind === "call") {
        context.lowering.emitCallStatement(context, expression);
        return "";
    }
    if (expression.kind === "postfix_op" || expression.kind === "prefix_op")
        return emitIncrementOrDecrement(context, expression);
    // comma sequence (for-update `i++, flags >>= 2`): emit each side effect in order.
    if (expression.kind === "sequence") {
        for (const sequenceExpression of expression.expressions) {
            const discardedText = emitDiscardedExpression(context, sequenceExpression);
            if (discardedText)
                context.lines.push(`    ${discardedText}`);
        }
        return "";
    }
    return "";
}
// A name held in a wasm local slot: a body-declared local OR a scalar (by-value) parameter. Both are
export function isScalarLocal(context: FunctionEmissionContext, name: string): boolean {
    if (context.localVars.has(name))
        return true;
    const type = context.params?.get(name);
    return !!type && !type.isAddr;
}
export function emitIncrementOrDecrement(context: FunctionEmissionContext, expression: Expression): string {
    const argument = expression.kind === "postfix_op" || expression.kind === "prefix_op" ? expression.argument : expression;
    const operator = (expression as any).operator === "++" ? "i64.add" : "i64.sub";
    // A scalar local/value-param increments in place via local.set, narrowed back to its declared width so overflow wraps like
    if (argument.kind === "identifier" && isScalarLocal(context, argument.name)) {
        const next = watIr.operation(operator, watIr.localGet(argument.name, "i64"), watIr.i64Constant(1));
        return `(local.set $${argument.name} ${watIr.serializeWatNode(context.lowering.narrowLocalValue(context, argument.name, next))})`;
    }
    // Otherwise a member/element lvalue: load, adjust, store back.
    const addr = context.lowering.resolveLvalue(context, argument);
    if (addr) {
        // uint128 increment/decrement uses the source-compiled arithmetic operator.
        if (isUint128(context.programAnalysis, addr.type ?? null)) {
            if ((expression as any).operator === "++") {
                const type = { kind: "template_instance", name: "uint128_t", callArguments: [] } as TypeSpec & {
                    kind: "template_instance";
                };
                const compiled = context.lowering.callCompiled(context, type, "operator++", addr.addr, []);
                if (!compiled || compiled.cm.retKind !== "i32") {
                    throw new Error("authoritative uint128_t::operator++ could not be lowered");
                }
                return watIr.serializeWatNode(watIr.operation("drop", watIr.functionCallWithSignature({ params: ["i32"], res: "i32" }, compiled.cm.label, addrIr(addr.addr))));
            }
            const one: Expression = { kind: "int_literal", value: "1", span: (expression as any).span };
            const res = context.lowering.lowerUint128Expression(context, {
                kind: "binary_op",
                operator: operator === "i64.add" ? "+" : "-",
                left: argument,
                right: one,
                span: (expression as any).span,
            });
            return watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(addr.addr), res, watIr.i32Constant(16)));
        }
        const load = emitScalarLoad(addr.addr, addr.size, isSignedScalarType(addr.type, context.programAnalysis));
        const stored = `(${operator} ${load} (i64.const 1))`;
        return emitScalarStore(addr.addr, addr.size, stored);
    }
    return "";
}
