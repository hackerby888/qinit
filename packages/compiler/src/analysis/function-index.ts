import { AstKind } from "../shared/enums";
import { EMPTY_TEMPLATE_BINDINGS, ResolvedSourceMethod, TemplateBindings } from "./types";
import type { TypeSpec, FunctionDecl, FunctionTemplateDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function methodOwnerNames(
    programAnalysis: ProgramAnalysis,
    name: string,
    seen = new Set<string>(),
): string[] {
    const bare = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
    if (seen.has(bare)) return [];
    seen.add(bare);
    const out = [bare];
    const struct =
        programAnalysis.globalStructs.get(name) ??
        programAnalysis.nested.get(name) ??
        programAnalysis.globalStructs.get(bare) ??
        programAnalysis.nested.get(bare);
    const directBases = struct?.bases ?? [];
    for (const baseType of directBases) {
        const resolvedBase = programAnalysis.resolveType(baseType, EMPTY_TEMPLATE_BINDINGS);
        const baseName = programAnalysis.baseTemplateName(resolvedBase);
        if (baseName) out.push(...programAnalysis.methodOwnerNames(baseName, seen));
    }
    return out;
}

export function baseTemplateName(type: TypeSpec): string | null {
    if (type.kind === AstKind.NAME) return type.name;
    if (type.kind === AstKind.TEMPLATE_INSTANCE) return type.name;
    return null;
}

export function hasInstanceMethod(
    programAnalysis: ProgramAnalysis,
    name: string,
    methodName: string,
): boolean {
    return programAnalysis.methodOwnerNames(name).some((owner) => {
        const methods = programAnalysis.templateMethods.get(owner);
        return (
            methods?.has(methodName) ||
            [...(methods?.keys() ?? [])].some((key) => key.startsWith(`${methodName}/`))
        );
    });
}

export function resolveSourceMethodDefinition(
    programAnalysis: ProgramAnalysis,
    ownerTypeName: string,
    ownerTemplateArguments: TypeSpec[],
    methodName: string,
    methodArgumentCount?: number,
    parameterTypeDiscriminator?: string,
): ResolvedSourceMethod | null {
    const ownerBindings = programAnalysis.bindContainer(ownerTypeName, ownerTemplateArguments);
    const templateInstance = programAnalysis.instantiateTemplate(
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

            programAnalysis.namespaceContexts.set(
                definition,
                programAnalysis.namespaceContextOf(selectedInlineMethod),
            );

            return {
                definition,
                ownerBindings,
                requiresMethodTemplateInference:
                    selectedInlineMethod.kind === AstKind.FUNCTION_TEMPLATE,
            };
        }
    }

    const specializationKey = programAnalysis.buildMethodSpecializationKey(
        methodName,
        methodArgumentCount,
        ownerTemplateArguments,
        ownerBindings,
    );
    const overloadKey = programAnalysis.buildMethodOverloadKey(
        methodName,
        methodArgumentCount,
        parameterTypeDiscriminator,
    );
    let definition: FunctionTemplateDecl | undefined;

    for (const ownerName of programAnalysis.methodOwnerNames(ownerTypeName)) {
        const methodsByName = programAnalysis.templateMethods.get(ownerName);
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
        !programAnalysis.templates.has(ownerTypeName) && definition.params.length > 0;

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
            defaultValue: parameter.defaultValue ?? methodDeclaration.params[index]?.defaultValue,
        })),
    };

    programAnalysis.namespaceContexts.set(
        definitionWithDefaults,
        programAnalysis.namespaceContextOf(definition),
    );

    return {
        definition: definitionWithDefaults,
        ownerBindings,
        requiresMethodTemplateInference,
    };
}

export function buildMethodSpecializationKey(
    programAnalysis: ProgramAnalysis,
    methodName: string,
    methodArgumentCount: number | undefined,
    ownerTemplateArguments: TypeSpec[],
    ownerBindings: TemplateBindings,
): string | undefined {
    if (methodArgumentCount === undefined || !ownerTemplateArguments[0]) return undefined;
    const firstTemplateArgument = programAnalysis.typeKey(
        programAnalysis.resolveType(ownerTemplateArguments[0], ownerBindings),
    );
    return `${methodName}/${methodArgumentCount}@${firstTemplateArgument}`;
}

export function buildMethodOverloadKey(
    methodName: string,
    methodArgumentCount: number | undefined,
    parameterTypeDiscriminator: string | undefined,
): string | undefined {
    if (methodArgumentCount === undefined || !parameterTypeDiscriminator) return undefined;
    return `${methodName}/${methodArgumentCount}@${parameterTypeDiscriminator}`;
}
