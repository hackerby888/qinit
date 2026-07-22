import { MATH_INTRINSIC_NAMES, SCALAR_SIZE, symbolBaseName } from "../abi/tables";
import { addrIr, narrowCastIr } from "../memory/memory-operations";
import { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { platformPrimitive } from "./platform-primitives";
import { describeShape, qpiWrapperMethod } from "./call-shape";
// rvalue call: a value helper, qpi getter, qpi valued host call, a value-returning container method, or a math
export function emitCallValueIr(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): watIr.WatNode {
    if (expression.callee.kind === "identifier" &&
        expression.callee.name === "__builtin_offsetof" &&
        expression.callArguments.length === 2) {
        const type = expression.callArguments[0];
        const member = expression.callArguments[1];
        if ((type.kind === "identifier" || type.kind === "qualified_name") && member.kind === "identifier") {
            const field = context.programAnalysis.fieldOf({ kind: "name", name: type.name }, member.name, context.thisBind);
            if (field)
                return watIr.i64Constant(field.offset);
        }
        context.programAnalysis.warn(`unsupported __builtin_offsetof`, expression.span.line);
        return watIr.i64Constant(0);
    }
    if (context.programAnalysis.gtestMode && expression.callee.kind === "identifier" && expression.callee.name === "getBalance") {
        const who = expression.callArguments[0] ? context.lowering.emitAddress(context, expression.callArguments[0]) : null;
        if (!who)
            throw new Error("gtest getBalance account must be addressable");
        return watIr.functionCall("$qt_balance", addrIr(who));
    }
    const primitive = expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name"
        ? platformPrimitive(expression.callee.name)
        : undefined;
    if (primitive) {
        for (const capability of primitive.capabilities ?? [])
            context.programAnalysis.capabilities.add(capability);
        if (expression.callArguments.length !== primitive.operands.length) {
            throw new Error(`${primitive.name} expects ${primitive.operands.length} argument(s), got ${expression.callArguments.length}`);
        }
    }
    if (primitive?.kind === "multiply-high") {
        const left = expression.callArguments[0] ? context.lowering.lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0);
        const right = expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
        const high = watIr.functionCall(primitive.signed ? "$intr_mulhi_s" : "$intr_mulhi_u", left, right);
        let output: Expression | undefined = expression.callArguments[2];
        while (output?.kind === "paren" || (output?.kind === "unary_op" && output.operator === "&")) {
            output = output.kind === "paren" ? output.expression : output.argument;
        }
        if (output?.kind === "identifier" && context.localVars.get(output.name)?.wasmType === "i64") {
            context.lines.push(`    ${context.lowering.setLocal(context, output.name, high)}`);
        }
        else {
            const out = expression.callArguments[2] ? context.lowering.emitAddress(context, expression.callArguments[2]) : null;
            if (!out)
                throw new Error(`${primitive.name} high-limb output is not addressable`);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, addrIr(out), high))}`);
        }
        return watIr.operation("i64.mul", left, right);
    }
    if (primitive?.kind === "wasm-unary" && primitive.wasmOp) {
        return watIr.operation(primitive.wasmOp, context.lowering.lowerValueExpression(context, expression.callArguments[0]));
    }
    if (primitive?.kind === "chain-rdrand" && primitive.width) {
        const output = context.lowering.emitAddress(context, expression.callArguments[0]);
        if (!output)
            throw new Error(`${primitive.name} output is not addressable`);
        return watIr.operation("i64.extend_i32_u", watIr.functionCall(`$intr_rdrand${primitive.width}`, addrIr(output)));
    }
    if (primitive?.kind === "mask-extract") {
        const input = context.lowering.emitAddress(context, expression.callArguments[0]);
        if (!input)
            throw new Error(`${primitive.name} operand must be addressable`);
        let mask: watIr.WatNode = watIr.i64Constant(0);
        for (let byte = 0; byte < 32; byte++) {
            const value = watIr.rawLoad("i64.load8_u", byte, addrIr(input));
            const bit = watIr.operation("i64.and", watIr.operation("i64.shr_u", value, watIr.i64Constant(7)), watIr.i64Constant(1));
            mask = watIr.operation("i64.or", mask, watIr.operation("i64.shl", bit, watIr.i64Constant(byte)));
        }
        return mask;
    }
    if (primitive?.kind === "test-zero") {
        const left = context.lowering.emitAddress(context, expression.callArguments[0]);
        const right = context.lowering.emitAddress(context, expression.callArguments[1]);
        if (!left || !right)
            throw new Error(`${primitive.name} operands must be addressable`);
        let combined: watIr.WatNode = watIr.i64Constant(0);
        for (let lane = 0; lane < 4; lane++) {
            const argument = watIr.rawLoad("i64.load", lane * 8, addrIr(left));
            const templateBindings = watIr.rawLoad("i64.load", lane * 8, addrIr(right));
            combined = watIr.operation("i64.or", combined, watIr.operation("i64.and", argument, templateBindings));
        }
        return watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", combined));
    }
    // ProposalVoting proxy `qpi(state.proposals).method(...)` — compile the real qpi.h proxy method against the wrapped ProposalVoting instance. A sibling proxy
    if (context.proxyClass) {
        const sib = context.lowering.emitProxySiblingCall(context, expression, true);
        if (sib !== null)
            return watIr.rawWatNode(sib, "i64", "unconverted: proxy sibling call");
    }
    {
        const wrapperMethod = qpiWrapperMethod(expression);
        if (wrapperMethod) {
            const real = context.lowering.emitProposalProxyCall(context, expression, true);
            if (real !== null)
                return watIr.rawWatNode(real, "i64", "unconverted: proposal proxy call");
            throw new Error(`authoritative proposal method '${wrapperMethod}' could not be lowered`);
        }
    }
    // Inter-contract call in value context — the _E forms capture the InterContractCallError into a variable (`InterContractCallError err =
    if (expression.callee.kind === "identifier" &&
        (expression.callee.name === "__qpi_call_other" || expression.callee.name === "__qpi_invoke_other")) {
        const wat = context.lowering.emitInterContract(context, expression, expression.callee.name === "__qpi_invoke_other");
        if (wat)
            return watIr.operation("i64.extend_i32_s", watIr.rawWatNode(wat, "i32", "unconverted: inter-contract call"));
        context.programAnalysis.warn(`unsupported inter-contract call to '${expression.callArguments[0]?.kind === "identifier" ? expression.callArguments[0].name : "?"}' (no callee IDL)`, expression.span.line);
        return watIr.i64Constant(0);
    }
    const ai = context.lowering.emitAssetIter(context, expression, "value");
    if (ai !== null)
        return watIr.rawWatNode(ai, "i64", "unconverted: asset iterator");
    const tc = context.lowering.emitThisCall(context, expression, true);
    if (tc !== null)
        return watIr.rawWatNode(tc, "i64", "unconverted: this-call");
    const helperCallText = context.lowering.emitHelperCall(context, expression, true);
    if (helperCallText !== null)
        return watIr.rawWatNode(helperCallText, "i64", "unconverted: helper call");
    if (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name") {
        const name = expression.callee.kind === "identifier" ? expression.callee.name : expression.callee.name;
        const base = symbolBaseName(name);
        if (MATH_INTRINSIC_NAMES.has(base)) {
            throw new Error(`authoritative QPI math function '${name}' could not be lowered`);
        }
    }
    const containerCallText = context.lowering.emitContainerCall(context, expression, true);
    if (containerCallText !== null)
        return watIr.rawWatNode(containerCallText, "i64", "source-compiled instance method");
    context.lowering.emitQpiCall(context, expression);
    // Functional-style scalar cast: uint64(x) / sint64(x) / uint8(x) / bit(x) ... — narrowed to the target
    if (expression.callee.kind === "identifier" &&
        SCALAR_SIZE[expression.callee.name] !== undefined &&
        expression.callArguments.length === 1) {
        return narrowCastIr(context.lowering.lowerValueExpression(context, expression.callArguments[0]), expression.callee.name);
    }
    // The same cast through a template parameter: T(x) inside a qpi.h template body where T binds to a
    if (expression.callee.kind === "identifier" && expression.callArguments.length === 1) {
        const bound = context.thisBind?.types.get(expression.callee.name);
        if (bound?.kind === "name" && SCALAR_SIZE[bound.name] !== undefined) {
            return narrowCastIr(context.lowering.lowerValueExpression(context, expression.callArguments[0]), bound.name);
        }
    }
    // uint128(i_high, i_low) two-arg constructor as a scalar value: the i64-collapsed model carries the low 64 bits, so the
    if (expression.callee.kind === "identifier" &&
        (expression.callee.name === "uint128" || expression.callee.name === "uint128_t") &&
        expression.callArguments.length === 2) {
        return context.lowering.lowerValueExpression(context, expression.callArguments[1]);
    }
    context.programAnalysis.warn(`unsupported call as value [${describeShape(expression)}]`, expression.span.line);
    return watIr.i64Constant(0);
}
export function emitCallValue(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): string {
    return watIr.serializeWatNode(emitCallValueIr(context, expression));
}
