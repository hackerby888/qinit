import { AstKind, WatNodeType } from "../../../shared/enums";
import { addrIr, narrowCast } from "../memory/memory-operations";
import type { FunctionEmissionContext } from "../types";
import type { Statement } from "../../../ast";
import * as watIr from "../wat-ir";

type ReturnStatement = Extract<Statement, { kind: AstKind.RETURN }>;

// A return either writes the output struct and falls through, or yields a scalar. Inlined methods keep
// their value on the stack instead of emitting a wasm return.
export function emitReturnStatement(context: FunctionEmissionContext, statement: ReturnStatement): void {
    if (context.inlineReturnLabel) {
        if (statement.value && context.retAddr) {
            const src = context.lowering.emitAddress(context, statement.value);
            if (src) {
                context.lines.push(
                    `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(context.retAddr), addrIr(src), watIr.i32Constant(context.retAggSize ?? 0)))}`,
                );
            } else if (context.retType && (statement.value.kind === AstKind.INITIALIZER_LIST || statement.value.kind === AstKind.CONSTRUCT)) {
                const callArguments = statement.value.kind === AstKind.INITIALIZER_LIST ? statement.value.expressions : statement.value.callArguments;
                if (!context.lowering.emitConstruct(context, context.retAddr, context.retType, callArguments)) {
                    throw new Error("aggregate return initializer could not be constructed");
                }
            } else {
                throw new Error("aggregate return expression from inline method is not addressable");
            }
        } else if (statement.value && context.inlineValueLocal) {
            context.lines.push(
                `    ${context.lowering.setLocal(context, context.inlineValueLocal, context.lowering.narrowLocalValue(context, context.inlineValueLocal, context.lowering.lowerValueExpression(context, statement.value)))}`,
            );
        }
        context.lines.push(`    (br ${context.inlineReturnLabel})`);
        return;
    }
    // Ignore value emission for inline `return *this`; the object flows by address.
    if (context.inlineMethod) return;
    if (statement.value && context.retAddr) {
        // Copy aggregate returns to the caller destination before returning.
        const src = context.lowering.emitAddress(context, statement.value);
        if (src) {
            context.lines.push(
                `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(context.retAddr!), addrIr(src), watIr.i32Constant(context.retAggSize!)))}`,
            );
        } else if (context.retType && (statement.value.kind === AstKind.INITIALIZER_LIST || statement.value.kind === AstKind.CONSTRUCT)) {
            const callArguments = statement.value.kind === AstKind.INITIALIZER_LIST ? statement.value.expressions : statement.value.callArguments;
            if (!context.lowering.emitConstruct(context, context.retAddr, context.retType, callArguments)) {
                throw new Error("aggregate return initializer could not be constructed");
            }
        } else {
            throw new Error("aggregate return expression is not addressable");
        }
        context.lowering.emitScratchpadReleases(context, 0, false);
        context.lines.push(`    (return)`);
    } else if (statement.value && context.retIsAddr) {
        // Apply reference-returning compound assignments before returning.
        let addr: string | null;
        if (statement.value.kind === AstKind.ASSIGN) {
            context.lowering.emitAssignment(context, statement.value);
            addr = context.lowering.emitAddress(context, statement.value.left);
        } else {
            addr = context.lowering.emitAddress(context, statement.value);
        }
        if (!addr) {
            context.programAnalysis.warn("reference return expression is not addressable", statement.span.line);
            context.lines.push("    (return (i32.const 0))");
            return;
        }
        const result = context.lowering.allocateTemporaryLocalName(context);
        context.lines.push(`    (local.set $${result} ${addr})`);
        context.lowering.emitScratchpadReleases(context, 0, false);
        context.lines.push(`    (return (local.get $${result}))`);
    } else if (statement.value && context.retIsValue) {
        // `return e` converts e to the declared return type (sub-64-bit returns truncate / sign-extend).
        const value = narrowCast(context.lowering.emitValue(context, statement.value), context.retTypeName);
        if (context.scratchpadScope?.length) {
            const result = context.lowering.allocateTemporaryLocalName(context);
            context.localVars.set(result, { wasmType: WatNodeType.I64 });
            context.lines.push(`    (local.set $${result} ${value})`);
            context.lowering.emitScratchpadReleases(context, 0, false);
            context.lines.push(`    (return (local.get $${result}))`);
        } else {
            context.lines.push(`    (return ${value})`);
        }
    } else {
        context.lowering.emitScratchpadReleases(context, 0, false);
        context.lines.push(`    (return)`);
    }
}
