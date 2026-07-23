import { AstKind, WatNodeType, type WatValueType } from "../../../enums";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { emitHelperFunction } from "../functions/function-emitter";
import { FunctionEmissionContext, CompiledHelperMetadata, TemplateBindings, EMPTY_TEMPLATE_BINDINGS } from "../types";
import { isAuthoritativeSymbol } from "../abi/tables";
import type { TypeSpec, Expression, FunctionDecl, FunctionTemplateDecl } from "../../../ast";
// Compile helpers with scalar-by-value and aggregate-by-address parameters.
export function compileLibraryFunction(programAnalysis: ProgramAnalysis, name: string, definition?: FunctionDecl, cacheKey = name): CompiledHelperMetadata | null {
    const cached = programAnalysis.helpers.get(cacheKey);
    if (cached)
        return cached;
    // Resolve via namespace candidates (using-directives + lexical source). libFns are keyed by full namespace path.
    let resolvedKey = name;
    let fn = definition;
    if (!fn) {
        for (const key of programAnalysis.namespaceCandidates(name)) {
            const hit = programAnalysis.libFns.get(key);
            if (hit) {
                fn = hit;
                resolvedKey = key;
                break;
            }
        }
    }
    if (!fn || !fn.body)
        return null;
    const params = fn.params.map((parameter) => {
        // Pass mutable scalar references by address for write-back.
        const isConstRef = parameter.type.kind === AstKind.REFERENCE && parameter.type.referentType?.kind === AstKind.CONST;
        const isPtrRef = (parameter.type.kind === AstKind.REFERENCE && !isConstRef) || parameter.type.kind === AstKind.POINTER;
        const isAddr = isPtrRef || programAnalysis.isAggregateType(parameter.type);
        const byValAgg = isAddr && parameter.type.kind !== AstKind.REFERENCE && parameter.type.kind !== AstKind.POINTER;
        const wasmType: WatValueType = isAddr
            ? WatNodeType.I32
            : WatNodeType.I64;
        return {
            name: parameter.name,
            wasmType,
            isAddr,
            type: programAnalysis.derefType(parameter.type),
            byValAgg,
        };
    });
    const retAgg = !programAnalysis.isVoidType(fn.returnType) && programAnalysis.isAggregateType(fn.returnType)
        ? programAnalysis.sizeOfType(fn.returnType)
        : undefined;
    const retIsValue = !programAnalysis.isVoidType(fn.returnType) && !retAgg;
    const nameSep = resolvedKey.lastIndexOf("::");
    const authoritative = isAuthoritativeSymbol(resolvedKey);
    const lookup = programAnalysis.namespaceContextOf(fn);
    const info: CompiledHelperMetadata = {
        label: `$lib${programAnalysis.helpers.size}_${resolvedKey.replace(/[^a-zA-Z0-9]/g, "_")}`,
        params,
        retIsValue,
        retAgg,
        retType: programAnalysis.derefType(fn.returnType),
        sourceNamespace: nameSep >= 0 ? resolvedKey.slice(0, nameSep) : undefined,
        usingNamespaces: lookup.usingNamespaces,
    };
    programAnalysis.helpers.set(cacheKey, info); // register before emit so recursion/sibling calls resolve
    try {
        const warningBase = programAnalysis.warnings.length;
        const errorBase = programAnalysis.errors.length;
        const wat = emitHelperFunction(programAnalysis, info, fn, { size: 0, align: 1, fields: new Map() });
        if (authoritative && (programAnalysis.warnings.length !== warningBase || programAnalysis.errors.length !== errorBase)) {
            const diagnostic = programAnalysis.errors[errorBase]?.message ??
                programAnalysis.warnings[warningBase]?.message ??
                "unknown lowering diagnostic";
            throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
        }
        programAnalysis.emittedMethodOrder.push(wat);
    }
    catch (entry: any) {
        programAnalysis.warn(`failed to compile lib fn ${resolvedKey}: ${entry.message}`, fn.span?.line ?? 0);
        programAnalysis.helpers.delete(cacheKey);
        if (authoritative)
            throw entry;
        return null;
    }
    return info;
}
// Deduce template bindings (T→sint64, L→4) for a free function template from the concrete types of its call-site arguments:
export function deduceLibraryFunctionBindings(context: FunctionEmissionContext, def: FunctionTemplateDecl, callArguments: Expression[], explicit: TypeSpec[] = []): TemplateBindings {
    const types = new Map<string, TypeSpec>();
    const values = new Map<string, bigint>();
    const typeParams = new Set(def.params.filter((parameter) => parameter.kind === AstKind.TYPE).map((type) => type.name));
    const valueParams = new Set(def.params.filter((parameter) => parameter.kind !== AstKind.TYPE).map((type) => type.name));
    const fps = def.functionParameters ?? [];
    def.params.forEach((param, index) => {
        const argument = explicit[index];
        if (!argument)
            return;
        if (param.kind === AstKind.TYPE) {
            types.set(param.name, context.thisBind ? context.programAnalysis.substInBindings(argument, context.thisBind) : argument);
        }
        else {
            values.set(param.name, context.programAnalysis.valueOfTypeArg(argument, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
        }
    });
    const argType = (expression: Expression): TypeSpec | null => {
        let type = context.lowering.resolveExpressionAddress(context, expression)?.type ?? null;
        if (!type) {
            // A computed uint128 rvalue has no lvalue address until call lowering materializes it,
            // but template deduction still sees its class type (`div(a * b, c)` in GGWP/Qswap).
            if (context.lowering.isU128Expr(context, expression))
                return { kind: AstKind.NAME, name: "uint128_t" };
            const scalar = context.lowering.scalarTypeInfo(context, expression);
            if (!scalar)
                return null;
            const name = scalar.width <= 4
                ? scalar.unsigned
                    ? "uint32"
                    : "sint32"
                : scalar.unsigned
                    ? "uint64"
                    : "sint64";
            return { kind: AstKind.NAME, name };
        }
        type = context.programAnalysis.derefType(type);
        // Resolve through the caller's template bindings so the deduced type is concrete (ProposalDataType → ProposalDataV1<false>), not a symbolic
        if (context.thisBind)
            type = context.programAnalysis.derefType(context.programAnalysis.substInBindings(type, context.thisBind));
        for (let index = 0; index < 8 && type.kind === AstKind.NAME; index++) {
            const td = context.programAnalysis.typedefs.get(type.name);
            if (!td)
                break;
            type = context.programAnalysis.derefType(td);
        }
        return type;
    };
    for (let fpIndex = 0; fpIndex < fps.length; fpIndex++) {
        const argument = callArguments[fpIndex];
        if (!argument)
            continue;
        const pt = context.programAnalysis.derefType(fps[fpIndex].type);
        if (pt.kind === AstKind.TEMPLATE_INSTANCE) {
            const at = argType(argument);
            if (at?.kind !== AstKind.TEMPLATE_INSTANCE || at.name !== pt.name)
                continue;
            for (let nestedIndex = 0; nestedIndex < pt.callArguments.length && nestedIndex < at.callArguments.length; nestedIndex++) {
                const pa = pt.callArguments[nestedIndex];
                if (pa.kind !== AstKind.NAME)
                    continue;
                if (typeParams.has(pa.name) && !types.has(pa.name))
                    types.set(pa.name, at.callArguments[nestedIndex]);
                else if (valueParams.has(pa.name) && !values.has(pa.name))
                    values.set(pa.name, context.programAnalysis.valueOfTypeArg(at.callArguments[nestedIndex]));
            }
        }
        else if (pt.kind === AstKind.NAME && typeParams.has(pt.name) && !types.has(pt.name)) {
            const at = argType(argument);
            if (at)
                types.set(pt.name, at);
        }
    }
    return { types, values, structs: new Map() };
}
// Pick the overload whose parameter patterns best match concrete arguments.
export function selectLibraryFunctionOverload(context: FunctionEmissionContext, defs: FunctionTemplateDecl[], callArguments: Expression[]): FunctionTemplateDecl {
    if (defs.length === 1)
        return defs[0];
    const argTypeOf = (expression: Expression): TypeSpec | null => {
        let type = context.lowering.resolveExpressionAddress(context, expression)?.type ?? null;
        if (!type)
            return null;
        type = context.programAnalysis.derefType(type);
        if (context.thisBind)
            type = context.programAnalysis.derefType(context.programAnalysis.substInBindings(type, context.thisBind));
        return type;
    };
    const argTypes = callArguments.map(argTypeOf);
    const score = (def: FunctionTemplateDecl): number => {
        const fps = def.functionParameters ?? [];
        if (callArguments.length > fps.length)
            return -1;
        const tparams = new Set(def.params.map((parameter) => parameter.name));
        let size = 0;
        for (let index = 0; index < fps.length && index < callArguments.length; index++) {
            const pat = context.programAnalysis.derefType(fps[index].type);
            const at = argTypes[index];
            if (!at)
                continue;
            if (pat.kind === AstKind.NAME) {
                if (tparams.has(pat.name))
                    size += 1;
                else if (at.kind === AstKind.NAME && at.name === pat.name)
                    size += 2;
                continue;
            }
            if (pat.kind === AstKind.TEMPLATE_INSTANCE && at.kind === AstKind.TEMPLATE_INSTANCE) {
                if (pat.name !== at.name)
                    return -1;
                for (let nestedIndex = 0; nestedIndex < pat.callArguments.length && nestedIndex < at.callArguments.length; nestedIndex++) {
                    const pa = pat.callArguments[nestedIndex];
                    if (pa.kind !== AstKind.NAME)
                        continue;
                    if (tparams.has(pa.name)) {
                        size += 1;
                    }
                    else {
                        const aa = at.callArguments[nestedIndex];
                        if (aa.kind === AstKind.NAME && aa.name === pa.name)
                            size += 2;
                        else if (aa.kind === AstKind.TEMPLATE_INSTANCE && aa.name === pa.name)
                            size += 2;
                        else
                            return -1;
                    }
                }
            }
        }
        return size;
    };
    let best = defs[0];
    let bestScore = score(defs[0]);
    for (let definitionIndex = 1; definitionIndex < defs.length; definitionIndex++) {
        const size = score(defs[definitionIndex]);
        if (size > bestScore) {
            best = defs[definitionIndex];
            bestScore = size;
        }
    }
    return best;
}
// Instantiate a free function template for the concrete types at a call site, emitting its wasm function.
export function compileLibraryFunctionInstance(context: FunctionEmissionContext, def: FunctionTemplateDecl, callArguments: Expression[], explicit: TypeSpec[] = [], authoritative = false, sourceKey = def.name): CompiledHelperMetadata | null {
    const programAnalysis = context.programAnalysis;
    const bind = deduceLibraryFunctionBindings(context, def, callArguments, explicit);
    const keyArgs = def.params
        .map((parameter) => parameter.kind === AstKind.TYPE
        ? programAnalysis.typeKeyOf(bind.types.get(parameter.name) ?? { kind: AstKind.NAME, name: parameter.name })
        : (bind.values.get(parameter.name)?.toString() ?? parameter.name))
        .join(",");
    // The overload's source line disambiguates same-name defs whose deduced args coincide.
    const key = `${def.name}@${def.span?.line ?? 0}<${keyArgs}>`;
    const cached = programAnalysis.helpers.get(key);
    if (cached)
        return cached;
    const params = (def.functionParameters ?? []).map((parameter) => {
        const concrete = programAnalysis.substInBindings(programAnalysis.derefType(parameter.type), bind);
        const aggregate = programAnalysis.isAggregateType(concrete);
        const constScalarRef = parameter.type.kind === AstKind.REFERENCE && parameter.type.referentType.kind === AstKind.CONST && !aggregate;
        const isPtrRef = parameter.type.kind === AstKind.POINTER || (parameter.type.kind === AstKind.REFERENCE && !constScalarRef);
        const isAddr = isPtrRef || aggregate;
        const byValAgg = isAddr && !isPtrRef && aggregate;
        const wasmType: WatValueType = isAddr
            ? WatNodeType.I32
            : WatNodeType.I64;
        return {
            name: parameter.name,
            wasmType,
            isAddr,
            type: concrete,
            byValAgg,
        };
    });
    const retT = programAnalysis.substInBindings(programAnalysis.derefType(def.returnType), bind);
    const retAgg = !programAnalysis.isVoidType(def.returnType) && programAnalysis.isAggregateType(retT)
        ? programAnalysis.sizeOfType(retT, bind)
        : undefined;
    const retIsValue = !programAnalysis.isVoidType(def.returnType) && !retAgg;
    const sourceSep = sourceKey.lastIndexOf("::");
    const lookup = programAnalysis.namespaceContextOf(def);
    const info: CompiledHelperMetadata = {
        label: `$lib${programAnalysis.helpers.size}_${key.replace(/[^a-zA-Z0-9]/g, "_")}`,
        params,
        retIsValue,
        retAgg,
        retType: retT,
        sourceNamespace: sourceSep >= 0 ? sourceKey.slice(0, sourceSep) : undefined,
        usingNamespaces: lookup.usingNamespaces,
    };
    programAnalysis.helpers.set(key, info); // register before emit so recursive/sibling calls resolve
    try {
        const warningBase = programAnalysis.warnings.length;
        const errorBase = programAnalysis.errors.length;
        const wat = context.lowering.emitHelperFunction(programAnalysis, info, def, { size: 0, align: 1, fields: new Map() }, bind);
        if (authoritative && (programAnalysis.warnings.length !== warningBase || programAnalysis.errors.length !== errorBase)) {
            const diagnostic = programAnalysis.errors[errorBase]?.message ??
                programAnalysis.warnings[warningBase]?.message ??
                "unknown lowering diagnostic";
            throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
        }
        programAnalysis.emittedMethodOrder.push(wat);
    }
    catch (entry: any) {
        programAnalysis.warn(`failed to instantiate lib fn ${key}: ${entry.message}`, def.span?.line ?? 0);
        programAnalysis.helpers.delete(key);
        if (authoritative)
            throw entry;
        return null;
    }
    return info;
}
