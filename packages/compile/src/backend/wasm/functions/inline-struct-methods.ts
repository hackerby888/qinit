import { classifyMethodParam } from "../calls/containers";
import { FunctionEmissionContext, ResolvedAddress, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression, Statement, FunctionDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { addrIr } from "../memory/memory-operations";
// Resolve reference-returning inline member calls as addresses.
export function tryInlineStructMethod(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): ResolvedAddress | null {
    if (expression.callee.kind !== "member_access")
        return null;
    const method = expression.callee.member;
    const objNode = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!objNode || !objNode.layout || !objNode.type)
        return null;
    const struct = context.programAnalysis.structOf(objNode.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    if (!struct)
        return null;
    const fn = struct.members.find((member) => member.kind === "function" && (member as FunctionDecl).name === method && (member as FunctionDecl).body) as FunctionDecl | undefined;
    if (!fn)
        return null;
    // Keep scalar-returning methods on the normal value-call path.
    const returnsAddress = (type: TypeSpec): boolean => type.kind === "reference" ||
        type.kind === "pointer" ||
        (type.kind === "const" && returnsAddress(type.valueType));
    if (!returnsAddress(fn.returnType))
        return null;
    const addr = emitInlineStructMethod(context, objNode, fn, expression.callArguments);
    return { addr, type: objNode.type, size: objNode.size, layout: objNode.layout };
}
export function inlineMethodInfo(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): {
    object: ResolvedAddress;
    fn: FunctionDecl;
} | null {
    if (expression.callee.kind !== "member_access")
        return null;
    const object = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!object?.type || !object.layout)
        return null;
    if (object.type.kind === "template_instance")
        return null;
    const struct = context.programAnalysis.structOf(object.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    const method = expression.callee.member;
    const fn = struct?.members.find((member) => member.kind === "function" &&
        (member as FunctionDecl).name === method &&
        (member as FunctionDecl).body) as FunctionDecl | undefined;
    return fn ? { object, fn } : null;
}
export function emitInlineStructValue(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): watIr.WatNode | null {
    if (!context.programAnalysis.gtestMode)
        return null;
    const resolved = inlineMethodInfo(context, expression);
    if (!resolved ||
        context.programAnalysis.isVoidType(resolved.fn.returnType) ||
        context.programAnalysis.isAggregateType(context.programAnalysis.derefType(resolved.fn.returnType)))
        return null;
    const result = context.lowering.allocateTemporaryLocalName(context);
    context.localVars.set(result, { wasmType: "i64", type: context.programAnalysis.derefType(resolved.fn.returnType) });
    context.lines.push(`    ${context.lowering.setLocal(context, result, watIr.i64Constant(0))}`);
    emitInlineStructMethod(context, resolved.object, resolved.fn, expression.callArguments, { retValue: result });
    return watIr.localGet(result, "i64");
}
export function emitInlineStructStatement(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): boolean {
    if (!context.programAnalysis.gtestMode)
        return false;
    const resolved = inlineMethodInfo(context, expression);
    if (!resolved)
        return false;
    emitInlineStructMethod(context, resolved.object, resolved.fn, expression.callArguments);
    return true;
}
export function renameInlineLocals(body: Statement, suffix: string): Statement {
    const names = new Map<string, string>();
    const collect = (value: unknown): void => {
        if (!value || typeof value !== "object")
            return;
        if (Array.isArray(value)) {
            for (const item of value)
                collect(item);
            return;
        }
        const node = value as Record<string, unknown>;
        if (node.kind === "variable" && node.isMember === false && typeof node.name === "string") {
            names.set(node.name, `${node.name}${suffix}`);
        }
        for (const child of Object.values(node))
            collect(child);
    };
    collect(body);
    const clone = (value: unknown): unknown => {
        if (!value || typeof value !== "object")
            return value;
        if (Array.isArray(value))
            return value.map(clone);
        const node = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(node))
            out[key] = clone(child);
        if ((node.kind === "identifier" || (node.kind === "variable" && node.isMember === false)) &&
            typeof node.name === "string") {
            out.name = names.get(node.name) ?? node.name;
        }
        return out;
    };
    return clone(body) as Statement;
}
// Inline a struct method while retaining its object address in a temporary.
export function emitInlineStructMethod(context: FunctionEmissionContext, objNode: ResolvedAddress, fn: FunctionDecl, callArguments: Expression[], result: {
    retAddr?: string;
    retSize?: number;
    retValue?: string;
} = {}): string {
    const self = context.lowering.allocateTemporaryLocalName(context);
    context.lines.push(`    ${context.lowering.setLocal(context, self, addrIr(objNode.addr))}`);
    const bind = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
    const params = new Map<string, {
        wasmType: "i32" | "i64";
        isAddr: boolean;
        type: TypeSpec;
        local?: string;
    }>();
    for (let parameterIndex = 0; parameterIndex < fn.params.length; parameterIndex++) {
        const parameter = fn.params[parameterIndex];
        const cls = classifyMethodParam(context.programAnalysis, parameter, bind);
        const slot = `marg${context.tmpCount++}`;
        context.localVars.set(slot, { wasmType: cls.wasmType });
        const argument = callArguments[parameterIndex] ?? parameter.defaultValue;
        const paramType = context.programAnalysis.substInBindings(context.programAnalysis.derefType(parameter.type), bind);
        if (argument) {
            const value = cls.isAddr
                ? addrIr(context.lowering.argAddr(context, argument, context.programAnalysis.sizeOfType(paramType, bind), paramType, cls.readOnlyRef === true))
                : context.lowering.lowerValueExpression(context, argument);
            context.lines.push(`    ${context.lowering.setLocal(context, slot, value)}`);
        }
        // Keep dependent fields concrete inside the inlined body. Leaving `T` here made a `const T&`
        // parameter fall back to a signed 32-bit load even when the owning container bound T=uint64.
        params.set(parameter.name, {
            wasmType: cls.wasmType,
            isAddr: cls.isAddr,
            type: paramType,
            local: slot,
        });
    }
    const save = {
        thisLayout: context.thisLayout,
        thisType: context.thisType,
        thisAddr: context.thisAddr,
        params: context.params,
        inlineMethod: context.inlineMethod,
        retIsValue: context.retIsValue,
        retAddr: context.retAddr,
        retAggSize: context.retAggSize,
        retType: context.retType,
        inlineReturnLabel: context.inlineReturnLabel,
        inlineValueLocal: context.inlineValueLocal,
        retTypeName: context.retTypeName,
    };
    context.thisLayout = objNode.layout ?? undefined;
    context.thisType = objNode.type ?? undefined;
    context.thisAddr = `(local.get $${self})`;
    context.params = params;
    context.inlineMethod = true;
    context.retIsValue = false;
    context.retAddr = result.retAddr;
    context.retAggSize = result.retSize;
    context.retType = context.programAnalysis.derefType(fn.returnType);
    context.inlineValueLocal = result.retValue;
    context.retTypeName = fn.returnType.kind === "name" ? fn.returnType.name : undefined;
    const returnLabel = `$inline_return_${context.loopCount++}`;
    context.inlineReturnLabel = returnLabel;
    // Hoist inlined locals because the outer pre-scan cannot see them.
    const body = fn.body ? renameInlineLocals(fn.body, `__inline${context.tmpCount++}`) : undefined;
    if (body)
        context.lowering.collectFunctionLocals(body, context);
    context.lines.push(`    (block ${returnLabel}`);
    if (body)
        context.lowering.emitStatement(context, body);
    context.lines.push("    )");
    Object.assign(context, save);
    return `(local.get $${self})`;
}
