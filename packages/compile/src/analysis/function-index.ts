import { AstKind } from "../enums";
import { EMPTY_TEMPLATE_BINDINGS, ResolvedSourceMethod, TemplateBindings } from "./types";
import type { TypeSpec, FunctionDecl, FunctionTemplateDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function methodOwnerNames(context: ProgramAnalysisInternals, name: string, seen = new Set<string>()): string[] {
    const bare = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
    if (seen.has(bare))
        return [];
    seen.add(bare);
    const out = [bare];
    const struct = context.globalStructs.get(name) ??
        context.nested.get(name) ??
        context.globalStructs.get(bare) ??
        context.nested.get(bare);
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
    if (type.kind === AstKind.NAME)
        return type.name;
    if (type.kind === AstKind.TEMPLATE_INSTANCE)
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

export function resolveSourceMethodDefinition(
    context: ProgramAnalysisInternals,
    ownerTypeName: string,
    ownerTemplateArguments: TypeSpec[],
    methodName: string,
    methodArgumentCount?: number,
    parameterTypeDiscriminator?: string,
): ResolvedSourceMethod | null {
    const ownerBindings = context.bindContainer(ownerTypeName, ownerTemplateArguments);
    const templateInstance = context.instantiateTemplate(
        ownerTypeName,
        ownerTemplateArguments,
        EMPTY_TEMPLATE_BINDINGS,
    );

    if (templateInstance) {
        const inlineMethodCandidates = templateInstance.templateDeclaration.members.filter(
            (member) =>
                (member.kind === AstKind.FUNCTION || member.kind === AstKind.FUNCTION_TEMPLATE) &&
                (member as FunctionDecl | FunctionTemplateDecl).name === methodName &&
                (member as FunctionDecl | FunctionTemplateDecl).body,
        ) as Array<FunctionDecl | FunctionTemplateDecl>;
        const parametersOf = (method: FunctionDecl | FunctionTemplateDecl) =>
            method.kind === AstKind.FUNCTION_TEMPLATE
                ? (method.functionParameters ?? [])
                : method.params;

        let selectedInlineMethod = inlineMethodCandidates[0];

        if (methodArgumentCount !== undefined && inlineMethodCandidates.length > 1) {
            selectedInlineMethod =
                inlineMethodCandidates.find(
                    (method) => parametersOf(method).length === methodArgumentCount,
                ) ??
                inlineMethodCandidates.find(
                    (method) =>
                        parametersOf(method).length > methodArgumentCount &&
                        parametersOf(method)
                            .slice(methodArgumentCount)
                            .every((parameter) => parameter.defaultValue !== undefined),
                ) ??
                inlineMethodCandidates[0];
        }

        if (selectedInlineMethod) {
            const definition: FunctionTemplateDecl =
                selectedInlineMethod.kind === AstKind.FUNCTION_TEMPLATE
                    ? selectedInlineMethod
                    : {
                        kind: AstKind.FUNCTION_TEMPLATE,
                        name: selectedInlineMethod.name,
                        params: templateInstance.templateDeclaration.params,
                        functionParameters: selectedInlineMethod.params,
                        returnType: selectedInlineMethod.returnType,
                        body: selectedInlineMethod.body,
                        isConstexpr: selectedInlineMethod.isConstexpr,
                        span: selectedInlineMethod.span,
                    };

            context.namespaceContexts.set(
                definition,
                context.namespaceContextOf(selectedInlineMethod),
            );

            return {
                definition,
                ownerBindings,
                requiresMethodTemplateInference:
                    selectedInlineMethod.kind === AstKind.FUNCTION_TEMPLATE,
            };
        }
    }

    const specializationKey = context.buildMethodSpecializationKey(
        methodName,
        methodArgumentCount,
        ownerTemplateArguments,
        ownerBindings,
    );
    const overloadKey = context.buildMethodOverloadKey(
        methodName,
        methodArgumentCount,
        parameterTypeDiscriminator,
    );
    let definition: FunctionTemplateDecl | undefined;

    for (const ownerName of context.methodOwnerNames(ownerTypeName)) {
        const methodsByName = context.templateMethods.get(ownerName);
        definition =
            (overloadKey ? methodsByName?.get(overloadKey) : undefined) ??
            (specializationKey ? methodsByName?.get(specializationKey) : undefined) ??
            (methodArgumentCount !== undefined
                ? methodsByName?.get(`${methodName}/${methodArgumentCount}`)
                : undefined) ??
            methodsByName?.get(methodName);

        if (definition) {
            break;
        }
    }

    if (!definition?.body) {
        return null;
    }

    const methodDeclaration = templateInstance?.templateDeclaration.members.find(
        (member): member is FunctionDecl => {
            if (member.kind !== AstKind.FUNCTION || member.name !== methodName) {
                return false;
            }

            return member.params.length === (definition!.functionParameters ?? []).length;
        },
    );
    const requiresMethodTemplateInference =
        !context.templates.has(ownerTypeName) && definition.params.length > 0;

    if (!methodDeclaration) {
        return {
            definition,
            ownerBindings,
            requiresMethodTemplateInference,
        };
    }

    const definitionWithDefaults: FunctionTemplateDecl = {
        ...definition,
        functionParameters: (definition.functionParameters ?? []).map((parameter, index) => ({
            ...parameter,
            defaultValue:
                parameter.defaultValue ?? methodDeclaration.params[index]?.defaultValue,
        })),
    };

    context.namespaceContexts.set(
        definitionWithDefaults,
        context.namespaceContextOf(definition),
    );

    return {
        definition: definitionWithDefaults,
        ownerBindings,
        requiresMethodTemplateInference,
    };
}

export function buildMethodSpecializationKey(
    context: ProgramAnalysisInternals,
    methodName: string,
    methodArgumentCount: number | undefined,
    ownerTemplateArguments: TypeSpec[],
    ownerBindings: TemplateBindings,
): string | undefined {
    if (methodArgumentCount === undefined || !ownerTemplateArguments[0])
        return undefined;
    const firstTemplateArgument = context.typeKey(
        context.resolveType(ownerTemplateArguments[0], ownerBindings),
    );
    return `${methodName}/${methodArgumentCount}@${firstTemplateArgument}`;
}

export function buildMethodOverloadKey(
    context: ProgramAnalysisInternals,
    methodName: string,
    methodArgumentCount: number | undefined,
    parameterTypeDiscriminator: string | undefined,
): string | undefined {
    if (methodArgumentCount === undefined || !parameterTypeDiscriminator)
        return undefined;
    return `${methodName}/${methodArgumentCount}@${parameterTypeDiscriminator}`;
}
