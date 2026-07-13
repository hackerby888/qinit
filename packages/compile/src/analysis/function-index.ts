import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, FunctionDecl, FunctionTemplateDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function methodOwnerNames(context: ProgramAnalysisInternals, name: string, seen = new Set<string>()): string[] {
    const bare = name.includes("::") && !context.globalStructs.has(name) ? name.slice(name.lastIndexOf("::") + 2) : name;
    if (seen.has(bare))
        return [];
    seen.add(bare);
    const out = [bare];
    const struct = context.globalStructs.get(bare) ?? context.nested.get(bare);
    const directBases = struct?.bases ?? [];
    for (const baseType of directBases) {
        const resolvedBase = context.resolveType(baseType, EMPTY_TEMPLATE_BINDINGS);
        const baseName = context.baseTemplateName(resolvedBase);
        if (baseName)
            out.push(...context.methodOwnerNames(baseName, seen));
    }
    return out;
}

export function baseTemplateName(context: ProgramAnalysisInternals, type: TypeSpec): string | null {
    if (type.kind === "name")
        return type.name;
    if (type.kind === "template_instance")
        return type.name;
    return null;
}

export function hasInstanceMethod(context: ProgramAnalysisInternals, name: string, methodName: string): boolean {
    return context.methodOwnerNames(name).some((owner) => {
        const methods = context.templateMethods.get(owner);
        return (methods?.has(methodName) ||
            [...(methods?.keys() ?? [])].some((key) => key.startsWith(`${methodName}/`)));
    });
}

export function methodTemplate(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], methodName: string, argCount?: number, paramTypeKey?: string): {
    def: FunctionTemplateDecl;
    bind: TemplateBindings;
    memberTemplate?: boolean;
} | null {
    // bindContainer carries the full method-scope binding (params + nested typedefs like VoteStorageType + static constexprs); instantiateTemplate's binding omits
    const bind = context.bindContainer(name, callArguments);
    const inst = context.instantiateTemplate(name, callArguments, EMPTY_TEMPLATE_BINDINGS);
    if (inst) {
        // Overload selection by arity (DateAndTime::isValid() vs the static isValid(y,m,d,...)): prefer an exact parameter-count match, then one whose extra
        const matchingMembers = inst.templateDeclaration.members.filter((mm) => (mm.kind === "function" || mm.kind === "function_template") &&
            (mm as FunctionDecl | FunctionTemplateDecl).name === methodName &&
            (mm as FunctionDecl | FunctionTemplateDecl).body) as Array<FunctionDecl | FunctionTemplateDecl>;
        const methodParameterList = (member: FunctionDecl | FunctionTemplateDecl) => member.kind === "function_template" ? (member.functionParameters ?? []) : member.params;
        let selectedMember: FunctionDecl | FunctionTemplateDecl | undefined = matchingMembers[0];
        if (argCount !== undefined && matchingMembers.length > 1) {
            selectedMember =
                matchingMembers.find((member) => methodParameterList(member).length === argCount) ??
                    matchingMembers.find((member) => methodParameterList(member).length > argCount &&
                        methodParameterList(member)
                            .slice(argCount)
                            .every((parameter) => parameter.defaultValue !== undefined)) ??
                    matchingMembers[0];
        }
        if (selectedMember) {
            const functionDecl = selectedMember;
            const def: FunctionTemplateDecl = functionDecl.kind === "function_template"
                ? functionDecl
                : {
                    kind: "function_template",
                    name: functionDecl.name,
                    params: inst.templateDeclaration.params,
                    functionParameters: functionDecl.params,
                    returnType: functionDecl.returnType,
                    body: functionDecl.body,
                    isConstexpr: functionDecl.isConstexpr,
                    span: functionDecl.span,
                };
            context.namespaceContexts.set(def, context.namespaceContextOf(functionDecl));
            return {
                def,
                bind,
                memberTemplate: functionDecl.kind === "function_template",
            };
        }
    }
    const specializationKey = context.buildMethodSpecializationKey(methodName, argCount, callArguments, bind);
    const overloadKey = context.buildMethodOverloadKey(methodName, argCount, paramTypeKey);
    let def: FunctionTemplateDecl | undefined;
    for (const owner of context.methodOwnerNames(name)) {
        const byName = context.templateMethods.get(owner);
        def =
            (overloadKey ? byName?.get(overloadKey) : undefined) ??
                (specializationKey ? byName?.get(specializationKey) : undefined) ??
                (argCount !== undefined ? byName?.get(`${methodName}/${argCount}`) : undefined) ??
                byName?.get(methodName);
        if (def)
            break;
    }
    if (!def?.body)
        return null;
    // Out-of-class definitions do not repeat default arguments. Preserve defaults from the authoritative
    // class declaration so a source-compiled call such as needsCleanup() still passes its declared 50%.
    const declared = inst?.templateDeclaration.members.find((member): member is FunctionDecl => {
        if (member.kind !== "function")
            return false;
        if (member.name !== methodName)
            return false;
        return member.params.length === (def.functionParameters ?? []).length;
    });
    const memberTemplate = !context.templates.has(name) && def.params.length > 0;
    if (!declared)
        return { def, bind, memberTemplate };
    const mergedDef: FunctionTemplateDecl = {
        ...def,
        functionParameters: (def.functionParameters ?? []).map((param, index) => ({
            ...param,
            defaultValue: param.defaultValue ?? declared.params[index]?.defaultValue,
        })),
    };
    context.namespaceContexts.set(mergedDef, context.namespaceContextOf(def));
    return {
        def: mergedDef,
        bind,
        memberTemplate,
    };
}

export function buildMethodSpecializationKey(context: ProgramAnalysisInternals, methodName: string, argCount: number | undefined, callArguments: TypeSpec[], bind: TemplateBindings): string | undefined {
    if (argCount === undefined || !callArguments[0])
        return undefined;
    const firstArg = context.typeKey(context.resolveType(callArguments[0], bind));
    return `${methodName}/${argCount}@${firstArg}`;
}

export function buildMethodOverloadKey(context: ProgramAnalysisInternals, methodName: string, argCount: number | undefined, paramTypeKey: string | undefined): string | undefined {
    if (argCount === undefined || !paramTypeKey)
        return undefined;
    return `${methodName}/${argCount}@${paramTypeKey}`;
}
