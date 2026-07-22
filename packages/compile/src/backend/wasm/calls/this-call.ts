import { compileContainerMethod } from "./containers";
import { addrIr } from "../memory/memory-operations";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
export function emitThisCall(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}, valueWanted: boolean): string | null {
    if (!context.thisType ||
        context.thisType.kind !== "template_instance" ||
        expression.callee.kind !== "identifier")
        return null;
    const methodName = expression.callee.name;
    // memory builtins used by container bodies: reset → setMem(this, ...); removeByIndex → setMem(&elem, ...).
    if ((methodName === "setMem" || methodName === "copyMem") && !valueWanted) {
        const destination = context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)";
        if (methodName === "copyMem") {
            const src = context.lowering.emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)";
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(destination), addrIr(src), watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[2]))))}`);
        }
        else {
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", addrIr(destination), watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[1])), watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[2]))))}`);
        }
        return "";
    }
    // Resolve the dependent static call through the actual HashFunc template binding. This is important
    // both for the default HashFunction<KeyT> body and for contract-provided custom hashers.
    if (methodName.endsWith("::hash")) {
        const targetName = methodName.slice(0, methodName.lastIndexOf("::"));
        const bound = context.thisBind?.types.get(targetName);
        const target: (TypeSpec & {
            kind: "template_instance";
        }) | null = bound?.kind === "template_instance"
            ? bound
            : bound?.kind === "name"
                ? { kind: "template_instance", name: bound.name, callArguments: [] }
                : null;
        if (!target)
            throw new Error(`dependent hash target '${methodName}' is not bound`);
        const cm = compileContainerMethod(context.programAnalysis, target, "hash", expression.callArguments.length);
        if (!cm || cm.retKind !== "i64") {
            throw new Error(`authoritative QPI method ${target.name}::hash could not be lowered`);
        }
        const methodArgumentOperands = cm.functionParameters.map((fp, index) => {
            const methodArgument = expression.callArguments[index] ?? fp.defaultValue;
            if (!methodArgument)
                return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
            if (!fp.isAddr)
                return context.lowering.emitValue(context, methodArgument);
            const direct = context.lowering.emitAddress(context, methodArgument);
            if (direct)
                return direct;
            const spill = context.lowering.allocateScratchSlotNode(context, Math.max(8, context.programAnalysis.sizeOfType(context.programAnalysis.derefType(fp.type), context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)));
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, spill, context.lowering.lowerValueExpression(context, methodArgument)))}`);
            return watIr.serializeWatNode(spill);
        });
        return `(call ${cm.label} (local.get $this)${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`;
    }
    // Compile sibling calls against this container instance.
    const methodNameOnly = methodName.startsWith(`${context.thisType.name}::`)
        ? methodName.slice(context.thisType.name.length + 2)
        : methodName;
    const cm = compileContainerMethod(context.programAnalysis, context.thisType, methodNameOnly, expression.callArguments.length);
    if (!cm)
        return null;
    // Spill scalar locals passed by mutable reference, then write them back.
    const writeBacks: string[] = [];
    const methodArgumentOperands = cm.functionParameters.map((fp, fnParamIndex) => {
        const methodArgument = expression.callArguments[fnParamIndex] ?? fp.defaultValue;
        if (!methodArgument)
            return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
        if (methodArgument.kind === "nullptr_literal")
            return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
        if (!fp.isAddr)
            return context.lowering.emitValue(context, methodArgument);
        const emittedAddress = context.lowering.emitAddress(context, methodArgument);
        if (emittedAddress)
            return emittedAddress;
        // `&x` (pointer out-param) and parens unwrap to the same scalar-local spill as a bare `x`.
        let argSource: Expression = methodArgument;
        while (argSource.kind === "paren" || (argSource.kind === "unary_op" && argSource.operator === "&")) {
            argSource = argSource.kind === "paren" ? argSource.expression : argSource.argument;
        }
        const size = context.lowering.allocateScratchSlotNode(context, 8);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, size, context.lowering.lowerValueExpression(context, argSource)))}`);
        if (argSource.kind === "identifier" && context.localVars.get(argSource.name)?.wasmType === "i64") {
            writeBacks.push(`    ${context.lowering.setLocal(context, argSource.name, watIr.rawLoad("i64.load", null, size))}`);
        }
        return watIr.serializeWatNode(size);
    });
    const call = `(call ${cm.label} (local.get $this) ${methodArgumentOperands.join(" ")})`;
    if (valueWanted) {
        if (cm.retKind !== "i64") {
            context.lines.push(`    ${call}`);
            context.lines.push(...writeBacks);
            return "(i64.const 0)";
        }
        if (!writeBacks.length)
            return call;
        const returnScratch = `tmp${context.tmpCount++}`;
        context.localVars.set(returnScratch, { wasmType: "i64" });
        context.lines.push(`    ${context.lowering.setLocal(context, returnScratch, watIr.rawWatNode(call, "i64", "unconverted: container method call"))}`);
        context.lines.push(...writeBacks);
        return `(local.get $${returnScratch})`;
    }
    context.lines.push(cm.retKind === "i64"
        ? `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.rawWatNode(call, "i64", "unconverted: container method call")))}`
        : `    ${call}`);
    context.lines.push(...writeBacks);
    return "";
}
