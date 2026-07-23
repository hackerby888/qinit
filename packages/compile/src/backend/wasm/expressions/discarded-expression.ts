import {
  AstKind,
  BinaryOp,
  UpdateOp,
  WatNodeType,
} from "../../../enums";
import { addrIr, emitScalarLoad, isSignedScalarType, emitScalarStore } from "../memory/memory-operations";
import { isUint128 } from "../memory/address-resolution";
import { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
// Emit a statement expression; calls and assignments record their own effects.
export function emitDiscardedExpression(context: FunctionEmissionContext, expression: Expression): string {
    if (expression.kind === AstKind.ASSIGN) {
        context.lowering.emitAssignment(context, expression);
        return "";
    }
    if (expression.kind === AstKind.CALL) {
        context.lowering.emitCallStatement(context, expression);
        return "";
    }
    if (expression.kind === AstKind.POSTFIX_OP || expression.kind === AstKind.PREFIX_OP)
        return emitIncrementOrDecrement(context, expression);
    // comma sequence (for-update `i++, flags >>= 2`): emit each side effect in order.
    if (expression.kind === AstKind.SEQUENCE) {
        for (const sequenceExpression of expression.expressions) {
            const discardedText = emitDiscardedExpression(context, sequenceExpression);
            if (discardedText)
                context.lines.push(`    ${discardedText}`);
        }
        return "";
    }
    return "";
}
// Recognize locals and by-value scalar parameters held in Wasm slots.
export function isScalarLocal(context: FunctionEmissionContext, name: string): boolean {
    if (context.localVars.has(name))
        return true;
    const type = context.params?.get(name);
    return !!type && !type.isAddr;
}
export function emitIncrementOrDecrement(context: FunctionEmissionContext, expression: Expression): string {
    const argument = expression.kind === AstKind.POSTFIX_OP || expression.kind === AstKind.PREFIX_OP ? expression.argument : expression;
    const operator = (expression as any).operator === UpdateOp.INCREMENT
        ? "i64.add"
        : "i64.sub";
    // Narrow incremented scalar locals so overflow matches C++.
    if (argument.kind === AstKind.IDENTIFIER && isScalarLocal(context, argument.name)) {
        const next = watIr.operation(operator, watIr.localGet(argument.name, WatNodeType.I64), watIr.i64Constant(1));
        return `(local.set $${argument.name} ${watIr.serializeWatNode(context.lowering.narrowLocalValue(context, argument.name, next))})`;
    }
    // Otherwise a member/element lvalue: load, adjust, store back.
    const addr = context.lowering.resolveLvalue(context, argument);
    if (addr) {
        // uint128 increment/decrement uses the source-compiled arithmetic operator.
        if (isUint128(context.programAnalysis, addr.type ?? null)) {
            if ((expression as any).operator === UpdateOp.INCREMENT) {
                const type = { kind: AstKind.TEMPLATE_INSTANCE, name: "uint128_t", callArguments: [] } as TypeSpec & {
                    kind: AstKind.TEMPLATE_INSTANCE;
                };
                const compiled = context.lowering.callCompiled(context, type, "operator++", addr.addr, []);
                if (!compiled || compiled.cm.retKind !== WatNodeType.I32) {
                    throw new Error("authoritative uint128_t::operator++ could not be lowered");
                }
                return watIr.serializeWatNode(watIr.operation("drop", watIr.functionCallWithSignature({ params: [WatNodeType.I32], res: WatNodeType.I32 }, compiled.cm.label, addrIr(addr.addr))));
            }
            const one: Expression = { kind: AstKind.INT_LITERAL, value: "1", span: (expression as any).span };
            const res = context.lowering.lowerUint128Expression(context, {
                kind: AstKind.BINARY_OP,
                operator: operator === "i64.add"
                    ? BinaryOp.ADD
                    : BinaryOp.SUBTRACT,
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
