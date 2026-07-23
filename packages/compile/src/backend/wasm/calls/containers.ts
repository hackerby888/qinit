import {
    AstKind,
    ContainerEmissionMode,
    WatNodeType,
    type WatValueType,
} from "../../../enums";
import { getFunctionLoweringServices } from "../functions/function-lowering-registry";
import { emitScalarLoad, addrIr, isSignedScalarType } from "../memory/memory-operations";
import { TemplateBindings, CompiledMethod, FieldLayout, FunctionEmissionContext } from "../types";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { TypeSpec, Expression, FunctionTemplateDecl, ParamDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
// ---- compiling instantiated container methods from the real qpi.h bodies ----
// A method parameter's wasm calling convention: references/pointers and aggregates pass by address (i32), scalars pass by value (i64).
export function classifyMethodParam(programAnalysis: ProgramAnalysis, parameter: ParamDecl, bind: TemplateBindings): {
    name: string;
    wasmType: WatValueType;
    isAddr: boolean;
    type: TypeSpec;
    concreteType: TypeSpec;
    defaultValue?: Expression;
    readOnlyRef?: boolean;
} {
    const type = parameter.type;
    const isPtrOrRef = type.kind === AstKind.REFERENCE || type.kind === AstKind.POINTER;
    const readOnlyRef = type.kind === AstKind.REFERENCE && type.referentType.kind === AstKind.CONST;
    const deref = programAnalysis.derefType(type);
    const concrete = programAnalysis.substInBindings(deref, bind);
    const isAddr = isPtrOrRef || programAnalysis.isAggregateType(concrete);
    return {
        name: parameter.name,
        wasmType: isAddr ? WatNodeType.I32 : WatNodeType.I64,
        isAddr,
        type: type,
        concreteType: concrete,
        defaultValue: parameter.defaultValue,
        readOnlyRef,
    };
}
// Compile or reuse a source-backed container method.
export function compileContainerMethod(programAnalysis: ProgramAnalysis, type: TypeSpec & {
    kind: AstKind.TEMPLATE_INSTANCE;
}, methodName: string, methodArgumentCount?: number, parameterTypeDiscriminator?: string, resolveMethodArgumentTypes?: () => Array<TypeSpec | null>, explicitTemplateArgs: TypeSpec[] = []): CompiledMethod | null {
    const explicitTemplateKey = explicitTemplateArgs.map((argument) => programAnalysis.typeKeyOf(argument)).join(",");
    const baseInstanceKey = methodTypeKey(type, programAnalysis);
    const explicitTemplateSuffix = explicitTemplateKey ? `<${explicitTemplateKey}>` : "";
    const baseCacheKey = `${baseInstanceKey}::${methodName}/${methodArgumentCount ?? "?"}${parameterTypeDiscriminator ? `@${parameterTypeDiscriminator}` : ""}${explicitTemplateSuffix}`;
    const cachedTemplateMethod = programAnalysis.compiledMethods.get(baseCacheKey);
    if (cachedTemplateMethod)
        return cachedTemplateMethod;
    // Specialization-aware: body + bindings come from matched template instance (primary or partial specialization)
    const resolvedMethod = programAnalysis.resolveSourceMethodDefinition(
        type.name,
        type.callArguments,
        methodName,
        methodArgumentCount,
        parameterTypeDiscriminator,
    );
    if (!resolvedMethod || !resolvedMethod.definition.body)
        return null;
    const definition = resolvedMethod.definition;
    const resolvedMethodArgumentTypes = resolvedMethod.requiresMethodTemplateInference
        ? (resolveMethodArgumentTypes?.() ?? [])
        : [];
    const methodTemplateTypeKey = resolvedMethod.requiresMethodTemplateInference
        ? resolvedMethodArgumentTypes.map((argumentType) => (argumentType ? programAnalysis.typeKeyOf(argumentType) : "?")).join(",")
        : "";
    const cacheKey = `${baseCacheKey}${methodTemplateTypeKey ? `#${methodTemplateTypeKey}` : ""}`;
    const cached = programAnalysis.compiledMethods.get(cacheKey);
    if (cached)
        return cached;
    let ownerBindings = resolvedMethod.ownerBindings;
    if (explicitTemplateArgs.length) {
        const types = new Map(ownerBindings.types);
        const values = new Map(ownerBindings.values);
        definition.params.forEach((parameter, index) => {
            const argument = explicitTemplateArgs[index];
            if (!argument)
                return;
            if (parameter.kind === AstKind.TYPE)
                types.set(parameter.name, argument);
            else
                values.set(parameter.name, programAnalysis.valueOfTypeArg(argument, ownerBindings));
        });
        ownerBindings = { ...ownerBindings, types, values };
    }
    // Infer member-template types structurally from concrete call arguments instead of assigning
    // semantics to specific method names.
    if (resolvedMethod.requiresMethodTemplateInference && definition.params.some((param) => param.kind === AstKind.TYPE)) {
        const types = new Map(ownerBindings.types);
        const templateTypeNames = new Set(definition.params.filter((param) => param.kind === AstKind.TYPE).map((param) => param.name));
        for (let index = 0; index < (definition.functionParameters ?? []).length; index++) {
            const declared = programAnalysis.derefType(definition.functionParameters![index].type);
            const actual = resolvedMethodArgumentTypes[index];
            if (declared.kind === AstKind.NAME && templateTypeNames.has(declared.name) && actual) {
                types.set(declared.name, actual);
            }
        }
        ownerBindings = { ...ownerBindings, types };
    }
    const functionParameters = (definition.functionParameters ?? []).map((parameter) => classifyMethodParam(programAnalysis, parameter, ownerBindings));
    const retType = programAnalysis.substInBindings(programAnalysis.derefType(definition.returnType), ownerBindings);
    const returnsAddr = definition.returnType.kind === AstKind.REFERENCE || definition.returnType.kind === AstKind.POINTER;
    const returnsAggregate = !returnsAddr && !programAnalysis.isVoidType(definition.returnType) && programAnalysis.isAggregateType(retType);
    const retKind: WatNodeType = returnsAddr
        ? WatNodeType.I32
        : programAnalysis.isVoidType(definition.returnType) || returnsAggregate
            ? WatNodeType.VOID
            : WatNodeType.I64;
    const retAgg = returnsAggregate ? programAnalysis.sizeOfType(retType, ownerBindings) : undefined;
    const safeMethodName = methodName.replace(/[^a-zA-Z0-9_]/g, "_");
    const cm: CompiledMethod = {
        label: `$T${programAnalysis.compiledMethods.size}_${type.name}_${safeMethodName}`,
        functionParameters,
        retKind,
        retAgg,
        retType,
    };
    programAnalysis.compiledMethods.set(cacheKey, cm); // register before emitting so recursive/sibling calls resolve
    try {
        const warningBase = programAnalysis.warnings.length;
        const errorBase = programAnalysis.errors.length;
        const wat = emitTemplateMethod(programAnalysis, cm, definition, type, ownerBindings);
        if (programAnalysis.warnings.length !== warningBase || programAnalysis.errors.length !== errorBase) {
            const diagnostic = programAnalysis.errors[errorBase]?.message ??
                programAnalysis.warnings[warningBase]?.message ??
                "unknown lowering diagnostic";
            throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
        }
        programAnalysis.emittedMethodOrder.push(wat);
    }
    catch (entry: any) {
        programAnalysis.warn(`failed to compile ${cacheKey}: ${entry.message}`, definition.span?.line ?? 0);
        programAnalysis.compiledMethods.delete(cacheKey);
        // A selected authoritative body must compile; never fall back to handwritten lowering.
        throw entry;
    }
    return cm;
}
function methodTypeKey(type: TypeSpec & {
    kind: AstKind.TEMPLATE_INSTANCE;
}, context: ProgramAnalysis): string {
    const argumentKeys = type.callArguments.map((argument) => context.typeKeyOf(argument)).join(",");
    return `${type.name}<${argumentKeys}>`;
}
// Emit an instantiated method with `$this`, concrete parameters, and its body.
export function emitTemplateMethod(programAnalysis: ProgramAnalysis, cm: CompiledMethod, def: FunctionTemplateDecl, type: TypeSpec & {
    kind: AstKind.TEMPLATE_INSTANCE;
}, bind: TemplateBindings): string {
    const thisLayout = programAnalysis.containerLayout(type.name, type.callArguments);
    const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
    const lookup = programAnalysis.namespaceContextOf(def);
    const context: FunctionEmissionContext = {
        programAnalysis,
        state: empty,
        in: empty,
        out: empty,
        locals: empty,
        localVars: new Map(),
        lines: [],
        tmpCount: 0,
        loops: [],
        loopCount: 0,
        params: new Map(),
        retIsValue: cm.retKind === WatNodeType.I64,
        retIsAddr: cm.retKind === WatNodeType.I32,
        thisLayout,
        thisType: type,
        thisBind: bind,
        staticConsts: programAnalysis.staticConstsOf(type.name, bind),
        sourceNamespace: lookup.sourceNamespace,
        usingNamespaces: lookup.usingNamespaces,
        lowering: getFunctionLoweringServices()
    };
    if (cm.retAgg) {
        context.retAddr = "(local.get $__qinit_ret)";
        context.retAggSize = cm.retAgg;
        context.retType = cm.retType;
    }
    // Register concrete parameter types so scalar references load at the right width.
    for (const fnParam of cm.functionParameters)
        context.params!.set(fnParam.name, {
            wasmType: fnParam.wasmType,
            isAddr: fnParam.isAddr,
            type: fnParam.concreteType ?? programAnalysis.substInBindings(programAnalysis.derefType(fnParam.type), bind),
        });
    if (def.body)
        context.lowering.collectFunctionLocals(def.body, context);
    if (def.body)
        context.lowering.emitStatement(context, def.body);
    const retParam = cm.retAgg ? "(param $__qinit_ret i32) " : "";
    const paramDecls = cm.functionParameters.map((fnParam) => `(param $${fnParam.name} ${fnParam.wasmType})`).join(" ");
    const result = cm.retKind === WatNodeType.I64 ? " (result i64)" : cm.retKind === WatNodeType.I32 ? " (result i32)" : "";
    const header = `  (func ${cm.label} ${retParam}(param $this i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
    const localDecls = [...context.localVars.entries()].map(([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`);
    const tail = cm.retKind === WatNodeType.I64
        ? ["    (i64.const 0)"]
        : cm.retKind === WatNodeType.I32
            ? ["    (i32.const 0)"]
            : [];
    return [header, ...localDecls, ...context.lines, ...tail, "  )"].join("\n");
}
// Build a call using the compiled method's concrete parameter types.
export function callCompiled(context: FunctionEmissionContext, type: TypeSpec & {
    kind: AstKind.TEMPLATE_INSTANCE;
}, method: string, self: string, callArguments: Expression[], parameterTypeDiscriminator?: string, explicitTemplateArgs: TypeSpec[] = []): {
    call: string;
    cm: CompiledMethod;
    retDest?: string;
} | null {
    const methodArgTypes = () => callArguments.map((argument) => {
        const node = context.lowering.resolveExpressionAddress(context, argument);
        if (node?.type)
            return context.programAnalysis.derefType(node.type);
        if (argument.kind === AstKind.CONSTRUCT)
            return context.programAnalysis.derefType(argument.type);
        if (argument.kind === AstKind.CALL && argument.callee.kind === AstKind.IDENTIFIER) {
            const type: TypeSpec = { kind: AstKind.NAME, name: argument.callee.name };
            if (context.programAnalysis.isAggregateType(type))
                return type;
        }
        return null;
    });
    const cm = compileContainerMethod(context.programAnalysis, type, method, callArguments.length, parameterTypeDiscriminator, methodArgTypes, explicitTemplateArgs);
    if (!cm)
        return null;
    const minimumArgs = cm.functionParameters.findIndex((parameter) => parameter.defaultValue !== undefined);
    const minimum = minimumArgs < 0 ? cm.functionParameters.length : minimumArgs;
    if (callArguments.length < minimum || callArguments.length > cm.functionParameters.length) {
        const expected = minimum === cm.functionParameters.length ? `${minimum}` : `${minimum}..${cm.functionParameters.length}`;
        throw new Error(`${type.name}::${method} expects ${expected} argument(s), got ${callArguments.length}`);
    }
    const bind = context.programAnalysis.bindContainer(type.name, type.callArguments);
    const methodArgumentOperands = cm.functionParameters.map((methodParameter, methodParameterIndex) => {
        const callArgument = callArguments[methodParameterIndex] ?? methodParameter.defaultValue;
        if (!callArgument) {
            throw new Error(`${type.name}::${method} is missing required argument ${methodParameterIndex + 1}`);
        }
        if (callArgument.kind === AstKind.NULLPTR_LITERAL) {
            return methodParameter.isAddr ? "(i32.const 0)" : "(i64.const 0)";
        }
        const paramType = methodParameter.concreteType ??
            context.programAnalysis.substInBindings(context.programAnalysis.derefType(methodParameter.type), bind);
        if (!methodParameter.isAddr)
            return context.lowering.emitValue(context, callArgument);
        if (methodParameter.type.kind === AstKind.POINTER &&
            context.programAnalysis.isVoidType(methodParameter.type.pointee) &&
            !context.lowering.resolveExpressionAddress(context, callArgument)) {
            return "(i32.const 0)";
        }
        if (context.programAnalysis.isAggregateType(paramType)) {
            if (callArgument.kind === AstKind.INITIALIZER_LIST) {
                return context.lowering.argAddr(context, callArgument, context.programAnalysis.sizeOfType(paramType, bind), paramType, methodParameter.readOnlyRef === true);
            }
            const direct = context.lowering.emitAddress(context, callArgument);
            if (!direct)
                throw new Error(`${type.name}::${method} aggregate argument ${methodParameterIndex + 1} is not addressable`);
            return direct;
        }
        return context.lowering.argAddr(context, callArgument, context.programAnalysis.sizeOfType(paramType, bind), paramType, methodParameter.readOnlyRef === true);
    });
    let retDest = "";
    if (cm.retAgg)
        retDest = watIr.serializeWatNode(context.lowering.allocateScratchSlotNode(context, cm.retAgg));
    return {
        call: `(call ${cm.label}${retDest ? " " + retDest : ""} ${self}${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`,
        cm,
        ...(retDest ? { retDest } : {}),
    };
}
export function emitTemplateContainerCall(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.TEMPLATE_CALL;
}, valueWanted: boolean): string | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS)
        return null;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!node?.type)
        return null;
    let type: TypeSpec = node.type;
    if (type.kind === AstKind.NAME &&
        (context.programAnalysis.globalStructs.has(type.name) || context.programAnalysis.templateMethods.has(type.name))) {
        type = { kind: AstKind.TEMPLATE_INSTANCE, name: type.name, callArguments: [] };
    }
    if (type.kind !== AstKind.TEMPLATE_INSTANCE)
        return null;
    const compiled = callCompiled(context, type, expression.callee.member, node.addr, expression.callArguments, undefined, expression.templateArguments ?? []);
    if (!compiled)
        return null;
    if (valueWanted) {
        if (compiled.retDest || compiled.cm.retKind === WatNodeType.VOID)
            throw new Error(`aggregate or void method ${type.name}::${expression.callee.member} used as a scalar`);
        if (compiled.cm.retKind === WatNodeType.I32)
            return emitScalarLoad(compiled.call, context.programAnalysis.sizeOfType(compiled.cm.retType!), isSignedScalarType(compiled.cm.retType!, context.programAnalysis));
        return compiled.call;
    }
    context.lines.push(compiled.cm.retKind === WatNodeType.VOID ? `    ${compiled.call}` : `    (drop ${compiled.call})`);
    return "";
}
// Lower a source-backed instance call and return its scalar value when requested.
export function emitContainerCall(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.CALL;
}, valueWanted: boolean): string | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS)
        return null;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!node || !node.type)
        return null;
    // Resolve typedefs and bindings to the concrete container instance.
    let ct: TypeSpec | null = node.type;
    for (let index = 0; index < 8 && ct?.kind === AstKind.NAME; index++) {
        const next: TypeSpec | undefined = context.thisBind?.types.get(ct.name) ?? context.programAnalysis.typedefs.get(ct.name);
        if (!next)
            break;
        ct = next;
    }
    // Normalize plain inline structs to zero-argument instances.
    if (ct?.kind === AstKind.INLINE_STRUCT &&
        ct.struct.name &&
        context.programAnalysis.templateMethods.get(ct.struct.name)?.has(expression.callee.member)) {
        ct = { kind: AstKind.TEMPLATE_INSTANCE, name: ct.struct.name, callArguments: [] } as TypeSpec;
    }
    if (ct?.kind === AstKind.NAME &&
        (context.programAnalysis.globalStructs.has(ct.name) || context.programAnalysis.templateMethods.has(ct.name))) {
        ct = { kind: AstKind.TEMPLATE_INSTANCE, name: ct.name, callArguments: [] } as TypeSpec;
    }
    if (!ct || ct.kind !== AstKind.TEMPLATE_INSTANCE)
        return null;
    // Dispatch namespace-qualified container types by their base name.
    if (ct.name.includes("::") && !context.programAnalysis.templates.has(ct.name)) {
        ct = { ...ct, name: ct.name.slice(ct.name.lastIndexOf("::") + 2) };
    }
    node.type = ct;
    const map = node.addr;
    const member = expression.callee.member;
    // Route every captured instance method through source-backed instantiation.
    const compiled = callCompiled(context, node.type, member, map, expression.callArguments);
    if (!compiled)
        return null;
    if (valueWanted) {
        if (compiled.retDest) {
            context.lines.push(`    ${compiled.call}`);
            return `(i64.load ${compiled.retDest})`;
        }
        if (compiled.cm.retKind === WatNodeType.VOID)
            throw new Error(`void method ${node.type.name}::${member} used as a scalar`);
        if (compiled.cm.retKind === WatNodeType.I32) {
            if (!compiled.cm.retType || context.programAnalysis.isAggregateType(compiled.cm.retType)) {
                throw new Error(`aggregate reference ${node.type.name}::${member} used as a scalar`);
            }
            return emitScalarLoad(compiled.call, context.programAnalysis.sizeOfType(compiled.cm.retType, context.thisBind), isSignedScalarType(compiled.cm.retType, context.programAnalysis));
        }
        return compiled.call;
    }
    context.lines.push(compiled.cm.retKind === WatNodeType.VOID ? `    ${compiled.call}` : `    (drop ${compiled.call})`);
    return "";
}
// Lower asset-iterator methods in statement, value, or address context.
export function emitAssetIter(context: FunctionEmissionContext, expression: Expression & {
    kind: AstKind.CALL;
}, mode: ContainerEmissionMode): string | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS)
        return null;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    const tn = node?.type?.kind === AstKind.NAME ? (node.type as any).name : null;
    if (!node || (tn !== "AssetOwnershipIterator" && tn !== "AssetPossessionIterator"))
        return null;
    const method = expression.callee.member;
    const it = context.lowering.allocateTemporaryLocalName(context);
    context.lines.push(`    ${context.lowering.setLocal(context, it, addrIr(node.addr))}`);
    const itN = watIr.localGet(it, WatNodeType.I32);
    const iter = watIr.serializeWatNode(itN);
    const cursorN = watIr.rawLoad("i32.load", null, watIr.addressWithOffset(itN, 4));
    const count = `(i32.load ${iter})`;
    const cursor = watIr.serializeWatNode(cursorN);
    const record = context.programAnalysis.assetEnumerationRecord;
    const rec = `(i32.add (global.get $assetIterBase) (i32.mul ${cursor} (i32.const ${record.size})))`;
    if (method === "begin") {
        const selN = watIr.rawWatNode(context.lowering.materializeSelect(context, undefined), WatNodeType.I32);
        const asset = context.lowering.materializeAssetAddress(context, expression.callArguments[0], `${tn}.begin`);
        const kind = tn === "AssetPossessionIterator" ? 1 : 0;
        const enumerate = watIr.functionCall("$lh_assetEnumerate", watIr.i32Constant(kind), addrIr(asset), selN, selN, watIr.rawWatNode("(global.get $assetIterBase)", WatNodeType.I32), watIr.i32Constant(record.capacity));
        context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, itN, enumerate))}`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, watIr.addressWithOffset(itN, 4), watIr.i32Constant(0)))}`);
        return "";
    }
    if (method === "next") {
        context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, watIr.addressWithOffset(itN, 4), watIr.operation("i32.add", cursorN, watIr.i32Constant(1))))}`);
        return "";
    }
    if (method === "reachedEnd")
        return `(i64.extend_i32_u (i32.ge_u ${cursor} ${count}))`;
    if (method === "numberOfPossessedShares" || method === "numberOfOwnedShares")
        return `(i64.load (i32.add ${rec} (i32.const ${record.fields.shares.offset})))`;
    if (method === "possessor")
        return mode === ContainerEmissionMode.ADDRESS
            ? `(i32.add ${rec} (i32.const ${record.fields.possessor.offset}))`
            : `(i64.load (i32.add ${rec} (i32.const ${record.fields.possessor.offset})))`;
    if (method === "owner")
        return mode === ContainerEmissionMode.ADDRESS ? rec : `(i64.load ${rec})`;
    if (method === "ownershipManagingContract")
        return `(i64.extend_i32_u (i32.load16_u (i32.add ${rec} (i32.const ${record.fields.ownershipManagingContract.offset}))))`;
    return null;
}
