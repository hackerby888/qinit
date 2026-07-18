import { narrowCast } from "../memory/memory-operations";
import { unsignedScalar } from "../expressions/conversions";
import { FunctionEmissionContext, CompiledHelperMetadata, EMPTY_TEMPLATE_BINDINGS } from "../types";
import { MATH_INTRINSIC_NAMES, SCALAR_SIZE, isAuthoritativeSymbol, symbolBaseName } from "../abi/tables";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionTemplateDecl } from "../../../ast";
import { compileLibraryFunction } from "./library-function-compiler";
// Build the args for a helper call (scalar args by value, reference/aggregate args by address).
export function helperCallOps(context: FunctionEmissionContext, info: CompiledHelperMetadata, callArguments: Expression[]): string {
    return info.params
        .map((parameter, parameterIndex) => {
        const argument = callArguments[parameterIndex];
        if (!argument)
            throw new Error(`${info.sourceNamespace ?? info.label} is missing required argument ${parameterIndex + 1}`);
        if (parameter.isAddr) {
            return context.lowering.argAddr(context, argument, context.programAnalysis.sizeOfType(parameter.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS), parameter.type, false, true);
        }
        const declared = context.programAnalysis.derefType(parameter.type);
        const value = narrowCast(context.lowering.emitValue(context, argument), declared.kind === "name" ? declared.name : undefined);
        return parameter.wasmType === "i32" ? `(i32.wrap_i64 ${value})` : value;
    })
        .join(" ");
}
// Aggregate-returning helpers allocate destination first, then pass it as the leading $ret arg.
export function emitAggHelperCall(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}, info: CompiledHelperMetadata): string {
    const scratchAddress = context.lowering.allocateScratchSlot(context, info.retAgg!);
    const helperArgumentOperands = helperCallOps(context, info, expression.callArguments);
    context.lines.push(`    (call ${info.label} ${scratchAddress}${helperArgumentOperands ? " " + helperArgumentOperands : ""})`);
    return scratchAddress;
}
// Scalar width/signedness of a declared parameter or return type, or null for aggregates/unknowns.
export function scalarDeclInfo(context: FunctionEmissionContext, type: TypeSpec): {
    width: number;
    unsigned: boolean;
} | null {
    const dereferencedType = context.programAnalysis.derefType(type);
    const name = dereferencedType.kind === "name" && dereferencedType.name.includes("::")
        ? dereferencedType.name.slice(dereferencedType.name.lastIndexOf("::") + 2)
        : dereferencedType.kind === "name"
            ? dereferencedType.name
            : "";
    // The parser keeps a plain C `int` as `int`, while QPI's corresponding
    // typedef is spelled `sint32`. Treat the C spelling as its canonical signed
    const canonical = name === "int" || name === "signed"
        ? "signed int"
        : name === "unsigned"
            ? "unsigned int"
            : name;
    const normalized: TypeSpec = dereferencedType.kind === "name" ? { ...dereferencedType, name: canonical } : dereferencedType;
    const byteWidth = normalized.kind === "name" ? SCALAR_SIZE[normalized.name] : undefined;
    if (byteWidth === undefined || byteWidth > 8)
        return null;
    return { width: byteWidth, unsigned: unsignedScalar(normalized) };
}
// Rank a member-helper overload set against the call's argument types, mirroring C++ overload resolution over the scalar subset:
export function pickHelperOverload(context: FunctionEmissionContext, set: CompiledHelperMetadata[], callArguments: Expression[]): CompiledHelperMetadata {
    if (set.length === 1)
        return set[0];
    const argInfos = callArguments.map((argument) => context.lowering.scalarTypeInfo(context, argument));
    const rank = (cand: CompiledHelperMetadata): number => {
        if (cand.params.length !== callArguments.length)
            return -1;
        let size = 0;
        for (let argumentIndex = 0; argumentIndex < callArguments.length; argumentIndex++) {
            const pi = scalarDeclInfo(context, cand.params[argumentIndex].type);
            const ai = argInfos[argumentIndex];
            if (!pi || !ai)
                continue;
            if (pi.width === ai.width && pi.unsigned === ai.unsigned)
                size += 2;
            else if (pi.width === ai.width)
                size += 1;
        }
        return size;
    };
    let best = set[0];
    let bestScore = rank(set[0]);
    for (let setItemIndex = 1; setItemIndex < set.length; setItemIndex++) {
        const size = rank(set[setItemIndex]);
        if (size > bestScore) {
            best = set[setItemIndex];
            bestScore = size;
        }
    }
    return best;
}
// Resolve a helper / lib-fn name to its (possibly just-compiled) info, or null.
export function lookupHelper(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): CompiledHelperMetadata | null {
    if (expression.callee.kind !== "identifier")
        return null;
    // Match the intrinsics by base name — a qualified QPI::div would otherwise slip past this guard, get instantiated
    const name = expression.callee.name;
    const base = symbolBaseName(name);
    const sourceKeys = context.programAnalysis.namespaceCandidates(name, context.sourceNamespace, context.usingNamespaces);
    const set = context.programAnalysis.helperOverloads.get(expression.callee.name);
    let info: CompiledHelperMetadata | null | undefined = set?.length
        ? pickHelperOverload(context, set, expression.callArguments)
        : sourceKeys.map((key) => context.programAnalysis.helpers.get(key)).find((candidate) => candidate !== undefined);
    if (!info) {
        for (const sourceKey of sourceKeys) {
            const defs = context.programAnalysis.libFnOverloads.get(sourceKey);
            if (!defs?.length)
                continue;
            const compiled = defs
                .map((definition, index) => compileLibraryFunction(context.programAnalysis, sourceKey, definition, `${sourceKey}@${definition.span?.line ?? index}`))
                .filter((candidate): candidate is CompiledHelperMetadata => candidate !== null);
            if (compiled.length)
                info = pickHelperOverload(context, compiled, expression.callArguments);
            if (info)
                break;
        }
    }
    if (!info && !MATH_INTRINSIC_NAMES.has(base)) {
        for (const sourceKey of sourceKeys) {
            info = compileLibraryFunction(context.programAnalysis, sourceKey);
            if (info)
                break;
        }
    }
    if (!info) {
        // A namespace free function template (isArraySortedWithoutDuplicates<T,L>): instantiate for this call, picking the overload whose parameter patterns match the
        const templateKey = sourceKeys.find((key) => context.programAnalysis.libFnTemplates.has(key));
        const tdefs = templateKey ? context.programAnalysis.libFnTemplates.get(templateKey) : undefined;
        if (tdefs?.length)
            info = context.lowering.compileLibraryFunctionInstance(context, context.lowering.selectLibraryFunctionOverload(context, tdefs, expression.callArguments), expression.callArguments, (expression as Expression & {
                templateArguments?: TypeSpec[];
            }).templateArguments ?? [], isAuthoritativeSymbol(templateKey!), templateKey!);
    }
    if (!info && name.includes("::")) {
        // Qualified static member calls resolve by flattened namespace members; structByName strips qualifiers.
        const segs = name.split("::");
        const method = segs[segs.length - 1];
        const ownerName = segs.slice(0, -1).join("::");
        const boundOwner = context.thisBind?.types.get(ownerName) ?? context.thisBind?.types.get(ownerName.split("::").pop()!);
        const sd = boundOwner
            ? (context.programAnalysis.structOf(boundOwner, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) ?? undefined)
            : context.programAnalysis.structByName(ownerName, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
        const fn = sd?.members.find((member): member is Declaration & {
            kind: "function";
        } => member.kind === "function" && member.name === method && member.isStatic && !!member.body);
        if (sd && fn) {
            // Param/return types spelled in the owner's scope (const OracleReply&) name its nested structs — substitute them inline so
            const nestedOf = new Map(sd.members
                .filter((member): member is StructDecl => member.kind === "struct" && !!member.name)
                .map((structDeclaration) => [structDeclaration.name, structDeclaration]));
            const qual = (tp: TypeSpec): TypeSpec => {
                if (tp.kind === "const")
                    return { ...tp, valueType: qual(tp.valueType) };
                if (tp.kind === "reference")
                    return { ...tp, referentType: qual(tp.referentType) };
                if (tp.kind === "name" && nestedOf.has(tp.name))
                    return { kind: "inline_struct", struct: nestedOf.get(tp.name)!, span: tp.span };
                return tp;
            };
            const def: FunctionTemplateDecl = {
                kind: "function_template",
                name: `${sd.name}::${method}`,
                params: [],
                functionParameters: fn.params.map((parameter) => ({ ...parameter, type: qual(parameter.type) })),
                returnType: qual(fn.returnType),
                body: fn.body,
                isConstexpr: fn.isConstexpr,
                span: fn.span,
            };
            info = context.lowering.compileLibraryFunctionInstance(context, def, expression.callArguments);
        }
    }
    return info ?? null;
}
export function emitHelperCall(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}, valueWanted: boolean): string | null {
    const info = lookupHelper(context, expression);
    if (!info)
        return null;
    // An aggregate-returning helper flows as an address — materialize into a slot. In value context return 0
    if (info.retAgg) {
        const addr = emitAggHelperCall(context, expression, info);
        return valueWanted ? "(i64.const 0)" : (void addr, "");
    }
    const helperArgumentOperands = helperCallOps(context, info, expression.callArguments);
    const call = `(call ${info.label}${helperArgumentOperands ? " " + helperArgumentOperands : ""})`;
    if (valueWanted) {
        if (!info.retIsValue)
            return "(i64.const 0)";
        if (info.retWasmType === "i32") {
            const unsigned = info.retType ? unsignedScalar(context.programAnalysis.derefType(info.retType)) : true;
            return `(${unsigned ? "i64.extend_i32_u" : "i64.extend_i32_s"} ${call})`;
        }
        return call;
    }
    context.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
    return "";
}
