import {
    AstKind,
    ContainerEmissionMode,
    PlatformPrimitiveKind,
    UnaryOp,
    WatNodeType,
} from "../../../enums";
import { MATH_INTRINSIC_NAMES, SCALAR_SIZE, symbolBaseName } from "../abi/tables";
import { addrIr, narrowCastIr } from "../memory/memory-operations";
import { FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { platformPrimitive } from "./platform-primitives";
import { describeShape, qpiWrapperMethod } from "./call-shape";
// Lower calls used as scalar rvalues.
export function emitCallValueIr(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.CALL;
}): watIr.WatNode {
    if (expression.callee.kind === AstKind.IDENTIFIER &&
        expression.callee.name === "__builtin_offsetof" &&
        expression.callArguments.length === 2) {
        const type = expression.callArguments[0];
        const member = expression.callArguments[1];
        if ((type.kind === AstKind.IDENTIFIER || type.kind === AstKind.QUALIFIED_NAME) && member.kind === AstKind.IDENTIFIER) {
            const field = context.programAnalysis.fieldOf({ kind: AstKind.NAME, name: type.name }, member.name, context.thisBind);
            if (field)
                return watIr.i64Constant(field.offset);
        }
        context.programAnalysis.warn(`unsupported __builtin_offsetof`, expression.span.line);
        return watIr.i64Constant(0);
    }
    if (context.programAnalysis.gtestMode && expression.callee.kind === AstKind.IDENTIFIER && expression.callee.name === "getBalance") {
        const who = expression.callArguments[0] ? context.lowering.emitAddress(context, expression.callArguments[0]) : null;
        if (!who)
            throw new Error("gtest getBalance account must be addressable");
        return watIr.functionCall("$qt_balance", addrIr(who));
    }
    const primitive = expression.callee.kind === AstKind.IDENTIFIER || expression.callee.kind === AstKind.QUALIFIED_NAME
        ? platformPrimitive(expression.callee.name)
        : undefined;
    if (primitive) {
        for (const capability of primitive.capabilities ?? [])
            context.programAnalysis.capabilities.add(capability);
        if (expression.callArguments.length !== primitive.operands.length) {
            throw new Error(`${primitive.name} expects ${primitive.operands.length} argument(s), got ${expression.callArguments.length}`);
        }
    }
    if (primitive?.kind === PlatformPrimitiveKind.MULTIPLY_HIGH) {
        const left = expression.callArguments[0] ? context.lowering.lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0);
        const right = expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
        const high = watIr.functionCall(primitive.signed ? "$intr_mulhi_s" : "$intr_mulhi_u", left, right);
        let output: Expression | undefined = expression.callArguments[2];
        while (output?.kind === AstKind.PAREN || (output?.kind === AstKind.UNARY_OP && output.operator === UnaryOp.ADDRESS_OF)) {
            output = output.kind === AstKind.PAREN ? output.expression : output.argument;
        }
        if (
            output?.kind === AstKind.IDENTIFIER &&
            context.localVars.get(output.name)?.wasmType === WatNodeType.I64
        ) {
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
    if (primitive?.kind === PlatformPrimitiveKind.WASM_UNARY && primitive.wasmOp) {
        return watIr.operation(primitive.wasmOp, context.lowering.lowerValueExpression(context, expression.callArguments[0]));
    }
    if (primitive?.kind === PlatformPrimitiveKind.CHAIN_RDRAND && primitive.width) {
        const output = context.lowering.emitAddress(context, expression.callArguments[0]);
        if (!output)
            throw new Error(`${primitive.name} output is not addressable`);
        return watIr.operation("i64.extend_i32_u", watIr.functionCall(`$intr_rdrand${primitive.width}`, addrIr(output)));
    }
    if (primitive?.kind === PlatformPrimitiveKind.MASK_EXTRACT) {
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
    if (primitive?.kind === PlatformPrimitiveKind.TEST_ZERO) {
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
    // Compile sibling ProposalVoting proxy calls through the source-backed path.
    if (context.proxyClass) {
        const sib = context.lowering.emitProxySiblingCall(context, expression, true);
        if (sib !== null)
            return watIr.rawWatNode(sib, WatNodeType.I64, "unconverted: proxy sibling call");
    }
    {
        const wrapperMethod = qpiWrapperMethod(expression);
        if (wrapperMethod) {
            const real = context.lowering.emitProposalProxyCall(context, expression, true);
            if (real !== null)
                return watIr.rawWatNode(real, WatNodeType.I64, "unconverted: proposal proxy call");
            throw new Error(`authoritative proposal method '${wrapperMethod}' could not be lowered`);
        }
    }
    // Preserve the i32 error result for value-form inter-contract calls.
    if (expression.callee.kind === AstKind.IDENTIFIER &&
        (expression.callee.name === "__qpi_call_other" || expression.callee.name === "__qpi_invoke_other")) {
        const wat = context.lowering.emitInterContract(context, expression, expression.callee.name === "__qpi_invoke_other");
        if (wat)
            return watIr.operation("i64.extend_i32_s", watIr.rawWatNode(wat, WatNodeType.I32, "unconverted: inter-contract call"));
        context.programAnalysis.warn(`unsupported inter-contract call to '${expression.callArguments[0]?.kind === AstKind.IDENTIFIER ? expression.callArguments[0].name : "?"}' (no callee IDL)`, expression.span.line);
        return watIr.i64Constant(0);
    }
    const ai = context.lowering.emitAssetIter(context, expression, ContainerEmissionMode.VALUE);
    if (ai !== null)
        return watIr.rawWatNode(ai, WatNodeType.I64, "unconverted: asset iterator");
    const tc = context.lowering.emitThisCall(context, expression, true);
    if (tc !== null)
        return watIr.rawWatNode(tc, WatNodeType.I64, "unconverted: this-call");
    const helperCallText = context.lowering.emitHelperCall(context, expression, true);
    if (helperCallText !== null)
        return watIr.rawWatNode(helperCallText, WatNodeType.I64, "unconverted: helper call");
    if (expression.callee.kind === AstKind.IDENTIFIER || expression.callee.kind === AstKind.QUALIFIED_NAME) {
        const name = expression.callee.kind === AstKind.IDENTIFIER ? expression.callee.name : expression.callee.name;
        const base = symbolBaseName(name);
        if (MATH_INTRINSIC_NAMES.has(base)) {
            throw new Error(`authoritative QPI math function '${name}' could not be lowered`);
        }
    }
    const containerCallText = context.lowering.emitContainerCall(context, expression, true);
    if (containerCallText !== null)
        return watIr.rawWatNode(containerCallText, WatNodeType.I64, "source-compiled instance method");
    context.lowering.emitQpiCall(context, expression);
    // Narrow functional scalar casts to the target width.
    if (expression.callee.kind === AstKind.IDENTIFIER &&
        SCALAR_SIZE[expression.callee.name] !== undefined &&
        expression.callArguments.length === 1) {
        return narrowCastIr(context.lowering.lowerValueExpression(context, expression.callArguments[0]), expression.callee.name);
    }
    // Resolve functional casts through bound template parameters.
    if (expression.callee.kind === AstKind.IDENTIFIER && expression.callArguments.length === 1) {
        const bound = context.thisBind?.types.get(expression.callee.name);
        if (bound?.kind === AstKind.NAME && SCALAR_SIZE[bound.name] !== undefined) {
            return narrowCastIr(context.lowering.lowerValueExpression(context, expression.callArguments[0]), bound.name);
        }
    }
    // In the scalar model, a two-argument uint128 constructor yields its low limb.
    if (expression.callee.kind === AstKind.IDENTIFIER &&
        (expression.callee.name === "uint128" || expression.callee.name === "uint128_t") &&
        expression.callArguments.length === 2) {
        return context.lowering.lowerValueExpression(context, expression.callArguments[1]);
    }
    context.programAnalysis.warn(`unsupported call as value [${describeShape(expression)}]`, expression.span.line);
    return watIr.i64Constant(0);
}
export function emitCallValue(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.CALL;
}): string {
    return watIr.serializeWatNode(emitCallValueIr(context, expression));
}
