import { AstKind, WatNodeType } from "../../../shared/enums";
import { narrowCast } from "../memory/memory-operations";
import { unsignedScalar } from "../expressions/conversions";
import { FunctionEmissionContext, CompiledHelperMetadata, EMPTY_TEMPLATE_BINDINGS } from "../types";
import { MATH_INTRINSIC_NAMES, SCALAR_SIZE, isAuthoritativeSymbol, symbolBaseName } from "../abi/tables";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionTemplateDecl } from "../../../ast";
import { compileLibraryFunction } from "./library-function-compiler";
import { isMutableScalarReference, spillForMutableReference } from "../memory/reference-arguments";
import * as watIr from "../wat-ir";
// Build the args for a helper call (scalar args by value, reference/aggregate args by address).
export function helperCallOps(
    context: FunctionEmissionContext,
    info: CompiledHelperMetadata,
    callArguments: Expression[],
): { operands: string; writeBacks: string[] } {
    const writeBacks: string[] = [];
    const operands = info.params
        .map((parameter, parameterIndex) => {
            const argument = callArguments[parameterIndex] ?? parameter.defaultValue;
            if (!argument) throw new Error(`${info.sourceNamespace ?? info.label} is missing required argument ${parameterIndex + 1}`);
            if (parameter.isAddr) {
                // A scalar passed by mutable reference goes as a scratch copy, so it has to be read back
                // afterwards. The container path did this already; the helper path dropped every write.
                if (isMutableScalarReference(context, parameter)) {
                    const spilled = spillForMutableReference(context, argument);
                    if (spilled) {
                        writeBacks.push(spilled.writeBack);
                        return spilled.addr;
                    }
                }
                return context.lowering.argAddr(
                    context,
                    argument,
                    context.programAnalysis.sizeOfType(parameter.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
                    parameter.type,
                    false,
                    true,
                );
            }
            const declared = context.programAnalysis.derefType(parameter.type);
            const value = narrowCast(context.lowering.emitValue(context, argument), declared.kind === AstKind.NAME ? declared.name : undefined);
            return parameter.wasmType === WatNodeType.I32 ? `(i32.wrap_i64 ${value})` : value;
        })
        .join(" ");
    return { operands, writeBacks };
}
// Aggregate-returning helpers allocate destination first, then pass it as the leading $ret arg.
export function emitAggHelperCall(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.CALL;
    },
    info: CompiledHelperMetadata,
): string {
    const scratchAddress = context.lowering.allocateScratchSlot(context, info.retAgg!);
    const { operands, writeBacks } = helperCallOps(context, info, expression.callArguments);
    context.lines.push(`    (call ${info.label} ${scratchAddress}${operands ? " " + operands : ""})`);
    context.lines.push(...writeBacks);
    return scratchAddress;
}
// Scalar width/signedness of a declared parameter or return type, or null for aggregates/unknowns.
export function scalarDeclInfo(
    context: FunctionEmissionContext,
    type: TypeSpec,
): {
    width: number;
    unsigned: boolean;
} | null {
    const dereferencedType = context.programAnalysis.derefType(type);
    const name =
        dereferencedType.kind === AstKind.NAME && dereferencedType.name.includes("::")
            ? dereferencedType.name.slice(dereferencedType.name.lastIndexOf("::") + 2)
            : dereferencedType.kind === AstKind.NAME
              ? dereferencedType.name
              : "";
    // Normalize plain C int spellings to QPI's signed scalar names.
    const canonical = name === "int" || name === "signed" ? "signed int" : name === "unsigned" ? "unsigned int" : name;
    const normalized: TypeSpec = dereferencedType.kind === AstKind.NAME ? { ...dereferencedType, name: canonical } : dereferencedType;
    const byteWidth = normalized.kind === AstKind.NAME ? SCALAR_SIZE[normalized.name] : undefined;
    if (byteWidth === undefined || byteWidth > 8) return null;
    return { width: byteWidth, unsigned: unsignedScalar(normalized) };
}
// Rank a member-helper overload set against the call's argument types, mirroring C++ overload resolution over the scalar subset:
export function pickHelperOverload(context: FunctionEmissionContext, set: CompiledHelperMetadata[], callArguments: Expression[]): CompiledHelperMetadata {
    if (set.length === 1) return set[0];
    const argInfos = callArguments.map((argument) => context.lowering.scalarTypeInfo(context, argument));
    // Viability as C++ defines it: an overload with P parameters of which D carry defaults accepts P-D
    // through P arguments, not P exactly.
    const requiredCount = (cand: CompiledHelperMetadata): number => {
        const firstDefault = cand.params.findIndex((parameter) => parameter.defaultValue !== undefined);
        return firstDefault < 0 ? cand.params.length : firstDefault;
    };
    const viable = (cand: CompiledHelperMetadata): boolean => callArguments.length >= requiredCount(cand) && callArguments.length <= cand.params.length;
    const rank = (cand: CompiledHelperMetadata): number => {
        if (!viable(cand)) return -1;
        // An exact arity match beats one that has to default a parameter, which separates two
        // overloads that are both viable for this call.
        let size = cand.params.length === callArguments.length ? 1 : 0;
        for (let argumentIndex = 0; argumentIndex < callArguments.length; argumentIndex++) {
            const pi = scalarDeclInfo(context, cand.params[argumentIndex].type);
            const ai = argInfos[argumentIndex];
            if (!pi || !ai) continue;
            if (pi.width === ai.width && pi.unsigned === ai.unsigned) size += 2;
            else if (pi.width === ai.width) size += 1;
        }
        return size;
    };
    // Seed with a viable candidate where there is one, so a set in which nothing ranks cannot return an
    // overload of the wrong arity in preference to one of the right arity.
    let best = set.find(viable) ?? set[0];
    let bestScore = rank(best);
    for (const candidate of set) {
        const size = rank(candidate);
        if (size > bestScore) {
            best = candidate;
            bestScore = size;
        }
    }
    return best;
}
// Resolve a helper / lib-fn name to its (possibly just-compiled) info, or null.
export function lookupHelper(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.CALL;
    },
): CompiledHelperMetadata | null {
    if (expression.callee.kind !== AstKind.IDENTIFIER) return null;
    // Match intrinsic base names before attempting source instantiation.
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
            if (!defs?.length) continue;
            const compiled = defs
                .map((definition, index) =>
                    compileLibraryFunction(context.programAnalysis, sourceKey, definition, `${sourceKey}@${definition.span?.line ?? index}`),
                )
                .filter((candidate): candidate is CompiledHelperMetadata => candidate !== null);
            if (compiled.length) info = pickHelperOverload(context, compiled, expression.callArguments);
            if (info) break;
        }
    }
    if (!info && !MATH_INTRINSIC_NAMES.has(base)) {
        for (const sourceKey of sourceKeys) {
            info = compileLibraryFunction(context.programAnalysis, sourceKey);
            if (info) break;
        }
    }
    if (!info) {
        // Instantiate the namespace template whose parameters best match this call.
        const templateKey = sourceKeys.find((key) => context.programAnalysis.libFnTemplates.has(key));
        const tdefs = templateKey ? context.programAnalysis.libFnTemplates.get(templateKey) : undefined;
        if (tdefs?.length)
            info = context.lowering.compileLibraryFunctionInstance(
                context,
                context.lowering.selectLibraryFunctionOverload(context, tdefs, expression.callArguments),
                expression.callArguments,
                (
                    expression as Expression & {
                        templateArguments?: TypeSpec[];
                    }
                ).templateArguments ?? [],
                isAuthoritativeSymbol(templateKey!),
                templateKey!,
            );
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
        const fn = sd?.members.find(
            (
                member,
            ): member is Declaration & {
                kind: AstKind.FUNCTION;
            } => member.kind === AstKind.FUNCTION && member.name === method && member.isStatic && !!member.body,
        );
        if (sd && fn) {
            // Resolve parameter and return types against nested owner declarations.
            const nestedOf = new Map(
                sd.members
                    .filter((member): member is StructDecl => member.kind === AstKind.STRUCT && !!member.name)
                    .map((structDeclaration) => [structDeclaration.name, structDeclaration]),
            );
            const qual = (tp: TypeSpec): TypeSpec => {
                if (tp.kind === AstKind.CONST) return { ...tp, valueType: qual(tp.valueType) };
                if (tp.kind === AstKind.REFERENCE) return { ...tp, referentType: qual(tp.referentType) };
                if (tp.kind === AstKind.NAME && nestedOf.has(tp.name))
                    return {
                        kind: AstKind.INLINE_STRUCT,
                        struct: nestedOf.get(tp.name)!,
                        span: tp.span,
                    };
                return tp;
            };
            const def: FunctionTemplateDecl = {
                kind: AstKind.FUNCTION_TEMPLATE,
                name: `${sd.name}::${method}`,
                params: [],
                functionParameters: fn.params.map((parameter) => ({
                    ...parameter,
                    type: qual(parameter.type),
                })),
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
export function emitHelperCall(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.CALL;
    },
    valueWanted: boolean,
): string | null {
    const info = lookupHelper(context, expression);
    if (!info) return null;
    // Materialize aggregate returns; scalar value contexts receive zero.
    if (info.retAgg) {
        const addr = emitAggHelperCall(context, expression, info);
        return valueWanted ? "(i64.const 0)" : (void addr, "");
    }
    const { operands, writeBacks } = helperCallOps(context, info, expression.callArguments);
    const call = `(call ${info.label}${operands ? " " + operands : ""})`;
    if (valueWanted) {
        if (!info.retIsValue) {
            context.lines.push(`    ${call}`);
            context.lines.push(...writeBacks);
            return "(i64.const 0)";
        }
        // The write-backs have to run after the call, so a value-context call carrying any of them is
        // sequenced through a temporary rather than returned inline.
        if (writeBacks.length) {
            const returned = `tmp${context.tmpCount++}`;
            context.localVars.set(returned, { wasmType: WatNodeType.I64 });
            const widened =
                info.retWasmType === WatNodeType.I32
                    ? `(${info.retType && !unsignedScalar(context.programAnalysis.derefType(info.retType)) ? "i64.extend_i32_s" : "i64.extend_i32_u"} ${call})`
                    : call;
            context.lines.push(`    ${context.lowering.setLocal(context, returned, watIr.rawWatNode(widened, WatNodeType.I64, "unconverted: helper call"))}`);
            context.lines.push(...writeBacks);
            return `(local.get $${returned})`;
        }
        if (info.retWasmType === WatNodeType.I32) {
            const unsigned = info.retType ? unsignedScalar(context.programAnalysis.derefType(info.retType)) : true;
            return `(${unsigned ? "i64.extend_i32_u" : "i64.extend_i32_s"} ${call})`;
        }
        return call;
    }
    context.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
    context.lines.push(...writeBacks);
    return "";
}
