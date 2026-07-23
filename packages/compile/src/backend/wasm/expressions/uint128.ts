import { AstKind, BinaryOp, WatNodeType } from "../../../enums";
import { MATH_INTRINSIC_NAMES, symbolBaseName } from "../abi/tables";
import { isUint128 } from "../memory/address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression, FunctionDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
// Detect uint128 expressions that require 16-byte source-backed operations.
export function isU128Expr(context: FunctionEmissionContext, expression: Expression): boolean {
    if (expression.kind === AstKind.PAREN)
        return isU128Expr(context, expression.expression);
    if (expression.kind === AstKind.CONSTRUCT)
        return isUint128(context.programAnalysis, expression.type);
    if (expression.kind === AstKind.C_CAST || expression.kind === AstKind.STATIC_CAST) {
        const type = (expression as any).type;
        if (type?.kind === AstKind.NAME && (type.name === "uint128" || type.name === "uint128_t"))
            return true;
        return isU128Expr(context, expression.expression);
    }
    if (expression.kind === AstKind.TERNARY)
        return isU128Expr(context, expression.then) || isU128Expr(context, expression.else_);
    if (expression.kind === AstKind.TEMPLATE_CALL && expression.callee.kind === AstKind.IDENTIFIER) {
        const base = symbolBaseName((expression.callee as any).name);
        if ((base === "div" || base === "mod") &&
            MATH_INTRINSIC_NAMES.has(base) &&
            expression.callArguments.length === 2) {
            const ta = expression.templateArguments?.[0];
            if (ta?.kind === AstKind.NAME && (ta.name === "uint128" || ta.name === "uint128_t"))
                return true;
            return isU128Expr(context, expression.callArguments[0]) || isU128Expr(context, expression.callArguments[1]);
        }
    }
    if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.IDENTIFIER) {
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
    if (expression.kind === AstKind.BINARY_OP) {
        if (expression.operator === BinaryOp.SHIFT_LEFT || expression.operator === BinaryOp.SHIFT_RIGHT)
            return isU128Expr(context, expression.left);
        if (expression.operator === BinaryOp.MULTIPLY ||
            expression.operator === BinaryOp.DIVIDE ||
            expression.operator === BinaryOp.ADD ||
            expression.operator === BinaryOp.SUBTRACT ||
            expression.operator === BinaryOp.BITWISE_AND ||
            expression.operator === BinaryOp.BITWISE_OR ||
            expression.operator === BinaryOp.BITWISE_XOR)
            return isU128Expr(context, expression.left) || isU128Expr(context, expression.right);
        return false;
    }
    // Trust declared method return types before attempting address resolution.
    if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.MEMBER_ACCESS) {
        const obj = context.lowering.resolveExpressionAddress(context, expression.callee.object);
        let ot: TypeSpec | null = obj?.type ?? null;
        for (let index = 0; index < 8 && ot?.kind === AstKind.NAME; index++) {
            const next = context.thisBind?.types.get(ot.name) ?? context.programAnalysis.typedefs.get(ot.name);
            if (!next)
                break;
            ot = next;
        }
        if (ot?.kind === AstKind.TEMPLATE_INSTANCE) {
            const resolvedMethod = context.programAnalysis.resolveSourceMethodDefinition(ot.name, ot.callArguments, expression.callee.member, expression.callArguments.length);
            if (resolvedMethod?.definition.returnType) {
                return isUint128(context.programAnalysis, context.programAnalysis.substInBindings(context.programAnalysis.derefType(resolvedMethod.definition.returnType), resolvedMethod.ownerBindings));
            }
        }
        const struct = ot ? context.programAnalysis.structOf(ot, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) : null;
        const fn = struct?.members.find((member) => member.kind === AstKind.FUNCTION &&
            (member as FunctionDecl).name === (expression.callee as Expression & {
                kind: AstKind.MEMBER_ACCESS;
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
    kind: AstKind.TEMPLATE_INSTANCE;
} = {
    kind: AstKind.TEMPLATE_INSTANCE,
    name: "uint128_t",
    callArguments: [],
};
export function constructU128(context: FunctionEmissionContext, callArguments: Expression[]): watIr.WatNode {
    const destination = context.lowering.allocateScratchSlotNode(context, 16);
    const compiled = context.lowering.callCompiled(context, U128_CLASS, "uint128_t", watIr.serializeWatNode(destination), callArguments);
    if (!compiled || compiled.cm.retKind !== WatNodeType.VOID) {
        throw new Error("authoritative uint128_t constructor could not be lowered");
    }
    context.lines.push(`    ${compiled.call}`);
    return destination;
}
export function u128ConstructorExpr(expression: Expression): Expression {
    return {
        kind: AstKind.CALL,
        callee: { kind: AstKind.IDENTIFIER, name: "uint128_t", span: expression.span },
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
        return watIr.rawWatNode(compiled.retDest, WatNodeType.I32, "source-compiled uint128 aggregate result");
    }
    if (compiled.cm.retKind === WatNodeType.I64)
        return watIr.rawWatNode(compiled.call, WatNodeType.I64, "source-compiled uint128 scalar result");
    if (compiled.cm.retKind === WatNodeType.I32)
        return watIr.rawWatNode(compiled.call, WatNodeType.I32, "source-compiled uint128 reference result");
    context.lines.push(`    ${compiled.call}`);
    throw new Error(`void uint128_t::${method} used as a value`);
}
// Materialize a uint128 expression into a 16-byte slot (low@0, high@8). Arithmetic and
// comparisons are instantiated from the authoritative platform/uint128.h method bodies.
export function lowerUint128Expression(context: FunctionEmissionContext, expression: Expression): watIr.WatNode {
    if (expression.kind === AstKind.PAREN)
        return lowerUint128Expression(context, expression.expression);
    if (expression.kind === AstKind.INITIALIZER_LIST)
        return constructU128(context, expression.expressions);
    if (expression.kind === AstKind.CONSTRUCT && isUint128(context.programAnalysis, expression.type))
        return constructU128(context, expression.callArguments);
    if (expression.kind === AstKind.C_CAST || expression.kind === AstKind.STATIC_CAST) {
        if (isU128Expr(context, expression.expression))
            return lowerUint128Expression(context, expression.expression);
        return constructU128(context, [expression.expression]);
    }
    const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
    if (resolvedAddress && isUint128(context.programAnalysis, resolvedAddress.type))
        return watIr.rawWatNode(resolvedAddress.addr, WatNodeType.I32, "lvalue address channel");
    if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.IDENTIFIER) {
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
            return watIr.rawWatNode(context.lowering.emitAggHelperCall(context, expression, helper), WatNodeType.I32, "source-compiled uint128 div result");
        }
    }
    if (expression.kind === AstKind.TEMPLATE_CALL &&
        expression.callee.kind === AstKind.IDENTIFIER &&
        symbolBaseName(expression.callee.name) === "div" &&
        MATH_INTRINSIC_NAMES.has("div") &&
        expression.callArguments.length === 2) {
        const callExpr = expression as unknown as Expression & {
            kind: AstKind.CALL;
        };
        const helper = context.lowering.lookupHelper(context, callExpr);
        if (!helper?.retAgg || helper.retAgg !== 16) {
            throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
        }
        return watIr.rawWatNode(context.lowering.emitAggHelperCall(context, callExpr, helper), WatNodeType.I32, "source-compiled uint128 div result");
    }
    if (expression.kind === AstKind.TERNARY) {
        const destination = context.lowering.allocateScratchSlotNode(context, 16);
        context.lines.push(`    (if ${watIr.serializeWatNode(watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, expression.condition)))} (then`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, lowerUint128Expression(context, expression.then), watIr.i32Constant(16)))}`);
        context.lines.push("    ) (else");
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, lowerUint128Expression(context, expression.else_), watIr.i32Constant(16)))}`);
        context.lines.push("    ))");
        return destination;
    }
    if (expression.kind === AstKind.BINARY_OP) {
        // The pinned uint128_t class has no |/^ overloads. Keep these representation-level bitwise
        // operations as compiler primitives; every defined class operator below is source-compiled.
        if (expression.operator === BinaryOp.BITWISE_OR || expression.operator === BinaryOp.BITWISE_XOR) {
            const destination = context.lowering.allocateScratchSlotNode(context, 16);
            const left = lowerUint128Expression(context, expression.left);
            const right = lowerUint128Expression(context, expression.right);
            const opcode = expression.operator === BinaryOp.BITWISE_OR ? "i64.or" : "i64.xor";
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, destination, watIr.operation(opcode, watIr.rawLoad("i64.load", null, left), watIr.rawLoad("i64.load", null, right))))}`);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", 8, destination, watIr.operation(opcode, watIr.rawLoad("i64.load", 8, left), watIr.rawLoad("i64.load", 8, right))))}`);
            return destination;
        }
        const method = [
            BinaryOp.ADD,
            BinaryOp.SUBTRACT,
            BinaryOp.MULTIPLY,
            BinaryOp.DIVIDE,
            BinaryOp.BITWISE_AND,
            BinaryOp.SHIFT_LEFT,
            BinaryOp.SHIFT_RIGHT,
        ].includes(expression.operator)
            ? `operator${expression.operator}`
            : null;
        if (method) {
            const left = lowerUint128Expression(context, expression.left);
            const scalarRight = !isU128Expr(context, expression.right);
            // Use scalar overloads only for `& int` and `>> unsigned int`; promote the rest.
            const key = scalarRight && expression.operator === BinaryOp.BITWISE_AND
                ? "int"
                : scalarRight && expression.operator === BinaryOp.SHIFT_RIGHT
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
