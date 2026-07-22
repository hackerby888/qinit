import { MATH_INTRINSIC_NAMES, symbolBaseName } from "../abi/tables";
import { isUint128 } from "../memory/address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression, FunctionDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
// Detect uint128 expressions that require 16-byte source-backed operations.
export function isU128Expr(context: FunctionEmissionContext, expression: Expression): boolean {
    if (expression.kind === "paren")
        return isU128Expr(context, expression.expression);
    if (expression.kind === "construct")
        return isUint128(context.programAnalysis, expression.type);
    if (expression.kind === "c_cast" || expression.kind === "static_cast") {
        const type = (expression as any).type;
        if (type?.kind === "name" && (type.name === "uint128" || type.name === "uint128_t"))
            return true;
        return isU128Expr(context, expression.expression);
    }
    if (expression.kind === "ternary")
        return isU128Expr(context, expression.then) || isU128Expr(context, expression.else_);
    if (expression.kind === "template_call" && expression.callee.kind === "identifier") {
        const base = symbolBaseName((expression.callee as any).name);
        if ((base === "div" || base === "mod") &&
            MATH_INTRINSIC_NAMES.has(base) &&
            expression.callArguments.length === 2) {
            const ta = expression.templateArguments?.[0];
            if (ta?.kind === "name" && (ta.name === "uint128" || ta.name === "uint128_t"))
                return true;
            return isU128Expr(context, expression.callArguments[0]) || isU128Expr(context, expression.callArguments[1]);
        }
    }
    if (expression.kind === "call" && expression.callee.kind === "identifier") {
        const nm = expression.callee.name;
        if (nm === "uint128" || nm === "uint128_t")
            return true;
        const bound = context.thisBind?.types.get(nm);
        if (bound && isUint128(context.programAnalysis, bound))
            return true;
        const base = symbolBaseName(nm);
        if ((base === "div" || base === "mod") &&
            MATH_INTRINSIC_NAMES.has(base) &&
            expression.callArguments.length === 2) {
            return isU128Expr(context, expression.callArguments[0]) || isU128Expr(context, expression.callArguments[1]);
        }
    }
    if (expression.kind === "binary_op") {
        if (expression.operator === "<<" || expression.operator === ">>")
            return isU128Expr(context, expression.left);
        if (expression.operator === "*" ||
            expression.operator === "/" ||
            expression.operator === "+" ||
            expression.operator === "-" ||
            expression.operator === "&" ||
            expression.operator === "|" ||
            expression.operator === "^")
            return isU128Expr(context, expression.left) || isU128Expr(context, expression.right);
        return false;
    }
    // Trust declared method return types before attempting address resolution.
    if (expression.kind === "call" && expression.callee.kind === "member_access") {
        const obj = context.lowering.resolveExpressionAddress(context, expression.callee.object);
        let ot: TypeSpec | null = obj?.type ?? null;
        for (let index = 0; index < 8 && ot?.kind === "name"; index++) {
            const next = context.thisBind?.types.get(ot.name) ?? context.programAnalysis.typedefs.get(ot.name);
            if (!next)
                break;
            ot = next;
        }
        if (ot?.kind === "template_instance") {
            const resolvedMethod = context.programAnalysis.resolveSourceMethodDefinition(ot.name, ot.callArguments, expression.callee.member, expression.callArguments.length);
            if (resolvedMethod?.definition.returnType) {
                return isUint128(context.programAnalysis, context.programAnalysis.substInBindings(context.programAnalysis.derefType(resolvedMethod.definition.returnType), resolvedMethod.ownerBindings));
            }
        }
        const struct = ot ? context.programAnalysis.structOf(ot, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) : null;
        const fn = struct?.members.find((member) => member.kind === "function" &&
            (member as FunctionDecl).name === (expression.callee as Expression & {
                kind: "member_access";
            }).member) as FunctionDecl | undefined;
        if (fn?.returnType) {
            return isUint128(context.programAnalysis, fn.returnType);
        }
    }
    const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
    return !!(resolvedAddress && isUint128(context.programAnalysis, resolvedAddress.type));
}
// Materialize uint128 expressions into fresh 16-byte slots when needed.
export const U128_CLASS: TypeSpec & {
    kind: "template_instance";
} = {
    kind: "template_instance",
    name: "uint128_t",
    callArguments: [],
};
export function constructU128(context: FunctionEmissionContext, callArguments: Expression[]): watIr.WatNode {
    const destination = context.lowering.allocateScratchSlotNode(context, 16);
    const compiled = context.lowering.callCompiled(context, U128_CLASS, "uint128_t", watIr.serializeWatNode(destination), callArguments);
    if (!compiled || compiled.cm.retKind !== "void") {
        throw new Error("authoritative uint128_t constructor could not be lowered");
    }
    context.lines.push(`    ${compiled.call}`);
    return destination;
}
export function u128ConstructorExpr(expression: Expression): Expression {
    return {
        kind: "call",
        callee: { kind: "identifier", name: "uint128_t", span: expression.span },
        callArguments: [expression],
        span: expression.span,
    };
}
export function sourceU128Result(context: FunctionEmissionContext, method: string, self: watIr.WatNode, callArguments: Expression[], paramTypeKey?: string): watIr.WatNode {
    const compiled = context.lowering.callCompiled(context, U128_CLASS, method, watIr.serializeWatNode(self), callArguments, paramTypeKey);
    if (!compiled)
        throw new Error(`authoritative uint128_t::${method} could not be lowered`);
    if (compiled.retDest) {
        context.lines.push(`    ${compiled.call}`);
        return watIr.rawWatNode(compiled.retDest, "i32", "source-compiled uint128 aggregate result");
    }
    if (compiled.cm.retKind === "i64")
        return watIr.rawWatNode(compiled.call, "i64", "source-compiled uint128 scalar result");
    if (compiled.cm.retKind === "i32")
        return watIr.rawWatNode(compiled.call, "i32", "source-compiled uint128 reference result");
    context.lines.push(`    ${compiled.call}`);
    throw new Error(`void uint128_t::${method} used as a value`);
}
// Materialize a uint128 expression into a 16-byte slot (low@0, high@8). Arithmetic and
// comparisons are instantiated from the authoritative platform/uint128.h method bodies.
export function lowerUint128Expression(context: FunctionEmissionContext, expression: Expression): watIr.WatNode {
    if (expression.kind === "paren")
        return lowerUint128Expression(context, expression.expression);
    if (expression.kind === "initializer_list")
        return constructU128(context, expression.expressions);
    if (expression.kind === "construct" && isUint128(context.programAnalysis, expression.type))
        return constructU128(context, expression.callArguments);
    if (expression.kind === "c_cast" || expression.kind === "static_cast") {
        if (isU128Expr(context, expression.expression))
            return lowerUint128Expression(context, expression.expression);
        return constructU128(context, [expression.expression]);
    }
    const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
    if (resolvedAddress && isUint128(context.programAnalysis, resolvedAddress.type))
        return watIr.rawWatNode(resolvedAddress.addr, "i32", "lvalue address channel");
    if (expression.kind === "call" && expression.callee.kind === "identifier") {
        const bound = context.thisBind?.types.get(expression.callee.name);
        const constructor = expression.callee.name === "uint128" ||
            expression.callee.name === "uint128_t" ||
            (bound ? isUint128(context.programAnalysis, bound) : false);
        if (constructor)
            return constructU128(context, expression.callArguments);
        if (symbolBaseName(expression.callee.name) === "div" &&
            MATH_INTRINSIC_NAMES.has("div") &&
            expression.callArguments.length === 2) {
            const helper = context.lowering.lookupHelper(context, expression);
            if (!helper?.retAgg || helper.retAgg !== 16) {
                throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
            }
            return watIr.rawWatNode(context.lowering.emitAggHelperCall(context, expression, helper), "i32", "source-compiled uint128 div result");
        }
    }
    if (expression.kind === "template_call" &&
        expression.callee.kind === "identifier" &&
        symbolBaseName(expression.callee.name) === "div" &&
        MATH_INTRINSIC_NAMES.has("div") &&
        expression.callArguments.length === 2) {
        const callExpr = expression as unknown as Expression & {
            kind: "call";
        };
        const helper = context.lowering.lookupHelper(context, callExpr);
        if (!helper?.retAgg || helper.retAgg !== 16) {
            throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
        }
        return watIr.rawWatNode(context.lowering.emitAggHelperCall(context, callExpr, helper), "i32", "source-compiled uint128 div result");
    }
    if (expression.kind === "ternary") {
        const destination = context.lowering.allocateScratchSlotNode(context, 16);
        context.lines.push(`    (if ${watIr.serializeWatNode(watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, expression.condition)))} (then`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, lowerUint128Expression(context, expression.then), watIr.i32Constant(16)))}`);
        context.lines.push("    ) (else");
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, lowerUint128Expression(context, expression.else_), watIr.i32Constant(16)))}`);
        context.lines.push("    ))");
        return destination;
    }
    if (expression.kind === "binary_op") {
        // The pinned uint128_t class has no |/^ overloads. Keep these representation-level bitwise
        // operations as compiler primitives; every defined class operator below is source-compiled.
        if (expression.operator === "|" || expression.operator === "^") {
            const destination = context.lowering.allocateScratchSlotNode(context, 16);
            const left = lowerUint128Expression(context, expression.left);
            const right = lowerUint128Expression(context, expression.right);
            const opcode = expression.operator === "|" ? "i64.or" : "i64.xor";
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, destination, watIr.operation(opcode, watIr.rawLoad("i64.load", null, left), watIr.rawLoad("i64.load", null, right))))}`);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", 8, destination, watIr.operation(opcode, watIr.rawLoad("i64.load", 8, left), watIr.rawLoad("i64.load", 8, right))))}`);
            return destination;
        }
        const method = ["+", "-", "*", "/", "&", "<<", ">>"].includes(expression.operator)
            ? `operator${expression.operator}`
            : null;
        if (method) {
            const left = lowerUint128Expression(context, expression.left);
            const scalarRight = !isU128Expr(context, expression.right);
            // Use scalar overloads only for `& int` and `>> unsigned int`; promote the rest.
            const key = scalarRight && expression.operator === "&"
                ? "int"
                : scalarRight && expression.operator === ">>"
                    ? "unsigned int"
                    : "uint128_t";
            const right = key === "uint128_t" && scalarRight ? u128ConstructorExpr(expression.right) : expression.right;
            return sourceU128Result(context, method, left, [right], key);
        }
    }
    return constructU128(context, [expression]);
}
export function emitU128(context: FunctionEmissionContext, expression: Expression): string {
    return watIr.serializeWatNode(lowerUint128Expression(context, expression));
}
