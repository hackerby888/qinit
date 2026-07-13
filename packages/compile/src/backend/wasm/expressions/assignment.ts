import { SCALAR_SIZE } from "../abi/tables";
import { describeShape } from "../calls/call-shape";
import { isUint128 } from "../memory/address-resolution";
import { addrIr, narrowCastIr } from "../memory/memory-operations";
import { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
export function newValueTmp(context: FunctionEmissionContext): string {
    let name: string;
    do
        name = `__qinit_value${context.tmpCount++}`;
    while (context.localVars.has(name) || context.params?.has(name));
    context.localVars.set(name, { wasmType: "i64" });
    return name;
}
// ---- assignment ----
// Lowers an assignment by pushing WAT lines to the function context; returns "" because the statement is fully emitted.
export function emitAssign(context: FunctionEmissionContext, expression: Expression & {
    kind: "assign";
}): string {
    if (context.programAnalysis.gtestMode &&
        expression.operator === "=" &&
        expression.left.kind === "member_access" &&
        expression.left.object.kind === "identifier" &&
        expression.left.object.name === "system" &&
        (expression.left.member === "epoch" || expression.left.member === "tick")) {
        const host = expression.left.member === "epoch" ? "$qt_set_epoch" : "$qt_set_tick";
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall(host, watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.right))))}`);
        return "";
    }
    const lhs = context.lowering.resolveExpressionAddress(context, expression.left);
    // uint128 plain assignment materializes RHS through source-compiled uint128_t helpers for computed expressions.
    if (lhs && expression.operator === "=" && isUint128(context.programAnalysis, lhs.type)) {
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(lhs.addr), context.lowering.lowerUint128Expression(context, expression.right), watIr.i32Constant(16)))}`);
        return "";
    }
    // aggregate target (id/m256i/struct/array): copy by value, or let a qpi producer write into it
    if (lhs && expression.operator === "=" && context.lowering.isAggregate(context, lhs.type, lhs.size)) {
        // Assignment-form iterator construction (`locals.aoi = AssetOwnershipIterator(asset)`): the RHS `Type(...)` parses as a plain call, so it has no
        if (lhs.type?.kind === "name" &&
            /Asset(Ownership|Possession)Iterator$/.test(lhs.type.name) &&
            (expression.right.kind === "call" || expression.right.kind === "construct") &&
            ((expression.right.kind === "call" &&
                expression.right.callee.kind === "identifier" &&
                /Asset(Ownership|Possession)Iterator$/.test(expression.right.callee.name)) ||
                expression.right.kind === "construct")) {
            const argument = expression.right.callArguments[0];
            if (argument) {
                context.lowering.emitAssetIter(context, {
                    kind: "call",
                    span: expression.span,
                    callArguments: [argument],
                    callee: { kind: "member_access", span: expression.span, object: expression.left, member: "begin" },
                } as Expression & {
                    kind: "call";
                }, "stmt");
            }
            else {
                context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, addrIr(lhs.addr), watIr.i64Constant(0)))}`); // zero count+cursor
            }
            return "";
        }
        // aggregate construction `target = Type{ ... }` (e.g. a Logger) — materialize the fields in place.
        if (expression.right.kind === "construct" &&
            lhs.type &&
            context.lowering.emitConstruct(context, lhs.addr, lhs.type, expression.right.callArguments)) {
            return "";
        }
        // bare brace-init-list `target = { a, b, c };` — same field-wise materialization, typed by the target.
        if (expression.right.kind === "initializer_list" &&
            lhs.type &&
            context.lowering.emitConstruct(context, lhs.addr, lhs.type, expression.right.expressions)) {
            return "";
        }
        const src = context.lowering.emitAddress(context, expression.right);
        if (src) {
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(lhs.addr), addrIr(src), watIr.i32Constant(lhs.size)))}`);
            return "";
        }
        context.programAnalysis.warn(`unsupported aggregate assignment [${describeShape(expression.left)} = ${describeShape(expression.right)}]`, expression.span.line);
        return "";
    }
    // uint128 compound assignment (z >>= n, prod -= y + z): lhs = lhs <op> rhs via the
    if (lhs && expression.operator !== "=" && isUint128(context.programAnalysis, lhs.type)) {
        const binOp = expression.operator.slice(0, -1);
        const src = context.lowering.lowerUint128Expression(context, {
            kind: "binary_op",
            operator: binOp,
            left: expression.left,
            right: expression.right,
            span: expression.span,
        } as Expression & {
            kind: "binary_op";
        });
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(lhs.addr), src, watIr.i32Constant(16)))}`);
        return "";
    }
    // scalar field target
    if (lhs) {
        if (expression.operator === "=") {
            context.lines.push(`    ${watIr.serializeWatNode(watIr.storeScalar(addrIr(lhs.addr), lhs.size, context.lowering.lowerValueExpression(context, expression.right)))}`);
            return "";
        }
        // Compound assignment lowers as lhs = lhs <op> rhs so the binary op carries the operands' real types
        context.lines.push(`    ${watIr.serializeWatNode(watIr.storeScalar(addrIr(lhs.addr), lhs.size, context.lowering.lowerValueExpression(context, compoundToBinary(expression))))}`);
        return "";
    }
    // local variable / scalar value-parameter target (both are mutable wasm locals)
    if (expression.left.kind === "identifier" && context.lowering.isScalarLocal(context, expression.left.name)) {
        const name = expression.left.name;
        const rhs = expression.operator === "=" ? context.lowering.lowerValueExpression(context, expression.right) : context.lowering.lowerValueExpression(context, compoundToBinary(expression));
        context.lines.push(`    ${context.lowering.setLocal(context, name, narrowLocalValue(context, name, rhs))}`);
        return "";
    }
    context.programAnalysis.warn(`unsupported assignment target [${describeShape(expression.left)}]`, expression.span.line);
    return "";
}
// Rewrite `lhs <op>= rhs` into the equivalent `lhs <op> rhs` expression node.
export function compoundToBinary(expression: Expression & {
    kind: "assign";
}): Expression {
    return {
        kind: "binary_op",
        operator: expression.operator.slice(0, -1),
        left: expression.left,
        right: expression.right,
        span: expression.span,
    } as Expression;
}
// Keep sub-64-bit scalar locals in canonical i64 form (zero-/sign-extended) on every store, so loads and compares can consume
export function narrowLocalValue(context: FunctionEmissionContext, name: string, value: watIr.WatNode): watIr.WatNode {
    const raw = context.localVars.get(name)?.type ?? context.params?.get(name)?.type;
    const type = raw ? context.programAnalysis.scalarStorageType(raw) : undefined;
    if (type?.kind === "name" && (SCALAR_SIZE[type.name] ?? 8) < 8) {
        return narrowCastIr(value, type.name);
    }
    return value;
}
