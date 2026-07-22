import { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { u128ConstructorExpr } from "./uint128";
export function lowerBinaryExpression(context: FunctionEmissionContext, expression: Expression & {
    kind: "binary_op";
}): watIr.WatNode {
    // uint128 comparisons instantiate the corresponding platform/uint128.h operator body.
    if ((expression.operator === "==" ||
        expression.operator === "!=" ||
        expression.operator === "<" ||
        expression.operator === ">" ||
        expression.operator === "<=" ||
        expression.operator === ">=") &&
        (context.lowering.isU128Expr(context, expression.left) || context.lowering.isU128Expr(context, expression.right))) {
        const left = context.lowering.lowerUint128Expression(context, expression.left);
        const method = expression.operator === "!=" ? "operator==" : `operator${expression.operator}`;
        const right = context.lowering.isU128Expr(context, expression.right) ? expression.right : u128ConstructorExpr(expression.right);
        const result = context.lowering.sourceU128Result(context, method, left, [right], "uint128_t");
        if (result.ty !== "i64")
            throw new Error(`uint128_t::${method} did not return a scalar`);
        return expression.operator === "!=" ? watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", result)) : result;
    }
    // id/struct equality compares bytes, not an i64 value.
    if (expression.operator === "==" || expression.operator === "!=") {
        const la = context.lowering.aggOperand(context, expression.left);
        const ra = context.lowering.aggOperand(context, expression.right);
        if (la && ra) {
            const eq = watIr.functionCall("$memeq", watIr.rawWatNode(la.addr, "i32", "lvalue address channel"), watIr.rawWatNode(ra.addr, "i32", "lvalue address channel"), watIr.i32Constant(Math.min(la.size, ra.size)));
            return expression.operator === "=="
                ? watIr.operation("i64.extend_i32_u", eq)
                : watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", eq));
        }
    }
    // id/m256i ordering is a 256-bit lexicographic compare of 4 u64 limbs.
    if (expression.operator === "<" || expression.operator === ">" || expression.operator === "<=" || expression.operator === ">=") {
        const la = context.lowering.aggOperand(context, expression.left);
        const ra = context.lowering.aggOperand(context, expression.right);
        if (la && ra && la.size === 32 && ra.size === 32) {
            const leftAddressAndSize = (left: {
                addr: string;
            }, right: {
                addr: string;
            }) => watIr.functionCall("$m256_lt", watIr.rawWatNode(left.addr, "i32", "lvalue address channel"), watIr.rawWatNode(right.addr, "i32", "lvalue address channel"));
            if (expression.operator === "<")
                return watIr.operation("i64.extend_i32_u", leftAddressAndSize(la, ra));
            if (expression.operator === ">")
                return watIr.operation("i64.extend_i32_u", leftAddressAndSize(ra, la));
            if (expression.operator === "<=") {
                return watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", leftAddressAndSize(ra, la)));
            }
            return watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", leftAddressAndSize(la, ra)));
        }
    }
    // Preserve C++ short-circuit evaluation for logical operators.
    if (expression.operator === "&&" || expression.operator === "||") {
        const lb = watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, expression.left));
        const saved = context.lines;
        context.lines = [];
        const rExpr = context.lowering.lowerValueExpression(context, expression.right);
        const rLines = context.lines;
        context.lines = saved;
        const rb = watIr.operation("i64.ne", watIr.i64Constant(0), rExpr);
        if (rLines.length === 0) {
            return expression.operator === "||"
                ? watIr.rawWatNode(`(i64.extend_i32_u (if (result i32) ${watIr.serializeWatNode(lb)} (then (i32.const 1)) (else ${watIr.serializeWatNode(rb)})))`, "i64", "inline if-expression")
                : watIr.rawWatNode(`(i64.extend_i32_u (if (result i32) ${watIr.serializeWatNode(lb)} (then ${watIr.serializeWatNode(rb)}) (else (i32.const 0))))`, "i64", "inline if-expression");
        }
        const temporaryLocalName = context.lowering.allocateTemporaryLocalName(context);
        const rBranch = [...rLines, `      (local.set $${temporaryLocalName} ${watIr.serializeWatNode(rb)})`].join("\n");
        if (expression.operator === "||") {
            context.lines.push(`    (if ${watIr.serializeWatNode(lb)} (then (local.set $${temporaryLocalName} (i32.const 1))) (else\n${rBranch}\n    ))`);
        }
        else {
            context.lines.push(`    (if ${watIr.serializeWatNode(lb)} (then\n${rBranch}\n    ) (else (local.set $${temporaryLocalName} (i32.const 0))))`);
        }
        return watIr.operation("i64.extend_i32_u", watIr.localGet(temporaryLocalName, "i32"));
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
        case "+":
            return wrapS(wrapL(watIr.operation("i64.add", valueNode, valueNodeCandidate), wrap32), swrap32);
        case "-":
            return wrapS(wrapL(watIr.operation("i64.sub", valueNode, valueNodeCandidate), wrap32), swrap32);
        case "*":
            return wrapS(wrapL(watIr.operation("i64.mul", valueNode, valueNodeCandidate), wrap32), swrap32);
        case "/":
            return watIr.operation(unsigned ? "i64.div_u" : "i64.div_s", lc, rc);
        case "%":
            return watIr.operation(unsigned ? "i64.rem_u" : "i64.rem_s", lc, rc);
        case "<<": {
            const sh = watIr.operation("i64.shl", valueNode, shiftCount(valueNodeCandidate));
            return li.width === 4 ? (li.unsigned ? wrapL(sh, true) : wrapS(sh, true)) : sh;
        }
        // Signed right-shift is arithmetic in C++ — zero-filling a negative sint64 silently corrupts it.
        case ">>":
            return watIr.operation(li.unsigned ? "i64.shr_u" : "i64.shr_s", valueNode, shiftCount(valueNodeCandidate));
        case "&":
            return watIr.operation("i64.and", valueNode, valueNodeCandidate);
        case "|":
            return wrapL(watIr.operation("i64.or", valueNode, valueNodeCandidate), wrap32);
        case "^":
            return wrapL(watIr.operation("i64.xor", valueNode, valueNodeCandidate), wrap32);
        case "==":
            return cmp("i64.eq");
        case "!=":
            return cmp("i64.ne");
        case "<":
            return cmp(unsigned ? "i64.lt_u" : "i64.lt_s");
        case ">":
            return cmp(unsigned ? "i64.gt_u" : "i64.gt_s");
        case "<=":
            return cmp(unsigned ? "i64.le_u" : "i64.le_s");
        case ">=":
            return cmp(unsigned ? "i64.ge_u" : "i64.ge_s");
        default:
            return watIr.i64Constant(0);
    }
}
