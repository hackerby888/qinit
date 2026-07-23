import { AstKind, BinaryOp, WatNodeType } from "../../../enums";
import { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { u128ConstructorExpr } from "./uint128";
export function lowerBinaryExpression(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.BINARY_OP;
}): watIr.WatNode {
    // uint128 comparisons instantiate the corresponding platform/uint128.h operator body.
    if ((expression.operator === BinaryOp.EQUAL ||
        expression.operator === BinaryOp.NOT_EQUAL ||
        expression.operator === BinaryOp.LESS_THAN ||
        expression.operator === BinaryOp.GREATER_THAN ||
        expression.operator === BinaryOp.LESS_THAN_OR_EQUAL ||
        expression.operator === BinaryOp.GREATER_THAN_OR_EQUAL) &&
        (context.lowering.isU128Expr(context, expression.left) || context.lowering.isU128Expr(context, expression.right))) {
        const left = context.lowering.lowerUint128Expression(context, expression.left);
        const method = expression.operator === BinaryOp.NOT_EQUAL ? "operator==" : `operator${expression.operator}`;
        const right = context.lowering.isU128Expr(context, expression.right) ? expression.right : u128ConstructorExpr(expression.right);
        const result = context.lowering.sourceU128Result(context, method, left, [right], "uint128_t");
        if (result.ty !== WatNodeType.I64)
            throw new Error(`uint128_t::${method} did not return a scalar`);
        return expression.operator === BinaryOp.NOT_EQUAL ? watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", result)) : result;
    }
    // id/struct equality compares bytes, not an i64 value.
    if (expression.operator === BinaryOp.EQUAL || expression.operator === BinaryOp.NOT_EQUAL) {
        const la = context.lowering.aggOperand(context, expression.left);
        const ra = context.lowering.aggOperand(context, expression.right);
        if (la && ra) {
            const eq = watIr.functionCall("$memeq", watIr.rawWatNode(la.addr, WatNodeType.I32, "lvalue address channel"), watIr.rawWatNode(ra.addr, WatNodeType.I32, "lvalue address channel"), watIr.i32Constant(Math.min(la.size, ra.size)));
            return expression.operator === BinaryOp.EQUAL
                ? watIr.operation("i64.extend_i32_u", eq)
                : watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", eq));
        }
    }
    // id/m256i ordering is a 256-bit lexicographic compare of 4 u64 limbs.
    if (expression.operator === BinaryOp.LESS_THAN || expression.operator === BinaryOp.GREATER_THAN || expression.operator === BinaryOp.LESS_THAN_OR_EQUAL || expression.operator === BinaryOp.GREATER_THAN_OR_EQUAL) {
        const la = context.lowering.aggOperand(context, expression.left);
        const ra = context.lowering.aggOperand(context, expression.right);
        if (la && ra && la.size === 32 && ra.size === 32) {
            const leftAddressAndSize = (left: {
                addr: string;
            }, right: {
                addr: string;
            }) => watIr.functionCall("$m256_lt", watIr.rawWatNode(left.addr, WatNodeType.I32, "lvalue address channel"), watIr.rawWatNode(right.addr, WatNodeType.I32, "lvalue address channel"));
            if (expression.operator === BinaryOp.LESS_THAN)
                return watIr.operation("i64.extend_i32_u", leftAddressAndSize(la, ra));
            if (expression.operator === BinaryOp.GREATER_THAN)
                return watIr.operation("i64.extend_i32_u", leftAddressAndSize(ra, la));
            if (expression.operator === BinaryOp.LESS_THAN_OR_EQUAL) {
                return watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", leftAddressAndSize(ra, la)));
            }
            return watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", leftAddressAndSize(la, ra)));
        }
    }
    // Preserve C++ short-circuit evaluation for logical operators.
    if (expression.operator === BinaryOp.LOGICAL_AND || expression.operator === BinaryOp.LOGICAL_OR) {
        const lb = watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, expression.left));
        const saved = context.lines;
        context.lines = [];
        const rExpr = context.lowering.lowerValueExpression(context, expression.right);
        const rLines = context.lines;
        context.lines = saved;
        const rb = watIr.operation("i64.ne", watIr.i64Constant(0), rExpr);
        if (rLines.length === 0) {
            return expression.operator === BinaryOp.LOGICAL_OR
                ? watIr.rawWatNode(`(i64.extend_i32_u (if (result i32) ${watIr.serializeWatNode(lb)} (then (i32.const 1)) (else ${watIr.serializeWatNode(rb)})))`, WatNodeType.I64, "inline if-expression")
                : watIr.rawWatNode(`(i64.extend_i32_u (if (result i32) ${watIr.serializeWatNode(lb)} (then ${watIr.serializeWatNode(rb)}) (else (i32.const 0))))`, WatNodeType.I64, "inline if-expression");
        }
        const temporaryLocalName = context.lowering.allocateTemporaryLocalName(context);
        const rBranch = [...rLines, `      (local.set $${temporaryLocalName} ${watIr.serializeWatNode(rb)})`].join("\n");
        if (expression.operator === BinaryOp.LOGICAL_OR) {
            context.lines.push(`    (if ${watIr.serializeWatNode(lb)} (then (local.set $${temporaryLocalName} (i32.const 1))) (else\n${rBranch}\n    ))`);
        }
        else {
            context.lines.push(`    (if ${watIr.serializeWatNode(lb)} (then\n${rBranch}\n    ) (else (local.set $${temporaryLocalName} (i32.const 0))))`);
        }
        return watIr.operation("i64.extend_i32_u", watIr.localGet(temporaryLocalName, WatNodeType.I32));
    }
    const valueNode = context.lowering.lowerValueExpression(context, expression.left);
    const valueNodeCandidate = context.lowering.lowerValueExpression(context, expression.right);
    // Apply usual arithmetic conversions and wrap 32-bit results.
    const cv = context.lowering.usualConversion(context, expression.left, expression.right);
    const unsigned = cv.unsigned;
    const li = context.lowering.promoteInfo(context, expression.left);
    const wrapL = (count: watIr.WatNode, active: boolean) => active ? watIr.operation("i64.and", count, watIr.i64Constant("0xffffffff")) : count;
    const wrapS = (count: watIr.WatNode, active: boolean) => (active ? watIr.operation("i64.extend32_s", count) : count);
    const wrap32 = unsigned && cv.width === 4;
    const swrap32 = !unsigned && cv.width === 4;
    const shiftCount = (count: watIr.WatNode) => (li.width === 4 ? watIr.operation("i64.and", count, watIr.i64Constant(31)) : count);
    // Signed-to-unsigned 32-bit converts by sign extension rules, so / and % follow unsigned arithmetic semantics.
    const toU32 = (count: watIr.WatNode, expression: Expression) => {
        if (!wrap32) {
            return count;
        }
        const pi = context.lowering.promoteInfo(context, expression);
        return pi.width === 4 && !pi.unsigned ? watIr.operation("i64.and", count, watIr.i64Constant("0xffffffff")) : count;
    };
    const lc = toU32(valueNode, expression.left);
    const rc = toU32(valueNodeCandidate, expression.right);
    const cmp = (operator: string) => watIr.operation("i64.extend_i32_u", watIr.operation(operator, lc, rc));
    switch (expression.operator) {
        case BinaryOp.ADD:
            return wrapS(wrapL(watIr.operation("i64.add", valueNode, valueNodeCandidate), wrap32), swrap32);
        case BinaryOp.SUBTRACT:
            return wrapS(wrapL(watIr.operation("i64.sub", valueNode, valueNodeCandidate), wrap32), swrap32);
        case BinaryOp.MULTIPLY:
            return wrapS(wrapL(watIr.operation("i64.mul", valueNode, valueNodeCandidate), wrap32), swrap32);
        case BinaryOp.DIVIDE:
            return watIr.operation(unsigned ? "i64.div_u" : "i64.div_s", lc, rc);
        case BinaryOp.MODULO:
            return watIr.operation(unsigned ? "i64.rem_u" : "i64.rem_s", lc, rc);
        case BinaryOp.SHIFT_LEFT: {
            const sh = watIr.operation("i64.shl", valueNode, shiftCount(valueNodeCandidate));
            return li.width === 4 ? (li.unsigned ? wrapL(sh, true) : wrapS(sh, true)) : sh;
        }
        // Signed right-shift is arithmetic in C++ — zero-filling a negative sint64 silently corrupts it.
        case BinaryOp.SHIFT_RIGHT:
            return watIr.operation(li.unsigned ? "i64.shr_u" : "i64.shr_s", valueNode, shiftCount(valueNodeCandidate));
        case BinaryOp.BITWISE_AND:
            return watIr.operation("i64.and", valueNode, valueNodeCandidate);
        case BinaryOp.BITWISE_OR:
            return wrapL(watIr.operation("i64.or", valueNode, valueNodeCandidate), wrap32);
        case BinaryOp.BITWISE_XOR:
            return wrapL(watIr.operation("i64.xor", valueNode, valueNodeCandidate), wrap32);
        case BinaryOp.EQUAL:
            return cmp("i64.eq");
        case BinaryOp.NOT_EQUAL:
            return cmp("i64.ne");
        case BinaryOp.LESS_THAN:
            return cmp(unsigned ? "i64.lt_u" : "i64.lt_s");
        case BinaryOp.GREATER_THAN:
            return cmp(unsigned ? "i64.gt_u" : "i64.gt_s");
        case BinaryOp.LESS_THAN_OR_EQUAL:
            return cmp(unsigned ? "i64.le_u" : "i64.le_s");
        case BinaryOp.GREATER_THAN_OR_EQUAL:
            return cmp(unsigned ? "i64.ge_u" : "i64.ge_s");
        default:
            return watIr.i64Constant(0);
    }
}
