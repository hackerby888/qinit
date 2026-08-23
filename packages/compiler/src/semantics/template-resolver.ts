import { AstKind } from "../shared/enums";
import { ClassTemplate, StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, Declaration, StructDecl, VariableDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function instantiateTemplate(
    programAnalysis: ProgramAnalysis,
    name: string,
    callArguments: TypeSpec[],
    parent: TemplateBindings,
): {
    templateDeclaration: ClassTemplate;
    b: TemplateBindings;
} | null {
    const resolvedArguments = callArguments.map((argument) => programAnalysis.resolveType(argument, parent));
    const templateDeclaration =
        programAnalysis.templates.get(name) ?? (name.includes("::") ? programAnalysis.templates.get(name.slice(name.lastIndexOf("::") + 2)) : undefined);
    if (!templateDeclaration) return null;
    const specialization = programAnalysis.matchTemplateSpecialization(name, resolvedArguments, parent);
    if (specialization) return specialization;
    const templateBindings = programAnalysis.instantiateTemplateBindings(templateDeclaration, resolvedArguments, parent);
    return {
        templateDeclaration,
        b: programAnalysis.withStaticConsts(templateDeclaration, templateBindings),
    };
}

export function matchTemplateSpecialization(
    programAnalysis: ProgramAnalysis,
    name: string,
    resolvedArguments: TypeSpec[],
    parent: TemplateBindings,
): {
    templateDeclaration: ClassTemplate;
    b: TemplateBindings;
} | null {
    const specializations = programAnalysis.specializations.get(name);
    if (!specializations) return null;
    for (const specialization of specializations) {
        if (specialization.specArgs.length !== resolvedArguments.length) continue;
        const paramByName = new Map(specialization.templateDeclaration.params.map((parameter) => [parameter.name, parameter] as const));
        const templateBindings: TemplateBindings = {
            types: new Map(),
            values: new Map(),
            structs: new Map(parent.structs),
        };
        let match = true;
        for (let specArgIndex = 0; specArgIndex < specialization.specArgs.length; specArgIndex++) {
            const specializationArg = specialization.specArgs[specArgIndex];
            const specializedParameter = specializationArg.kind === AstKind.NAME ? paramByName.get(specializationArg.name) : undefined;
            const instantiationArg = resolvedArguments[specArgIndex];
            if (specializedParameter) {
                if (specializedParameter.kind === AstKind.TYPE) {
                    // pattern variable — bind this specialization parameter to the instantiation argument
                    templateBindings.types.set(specializedParameter.name, instantiationArg);
                    continue;
                }
                templateBindings.values.set(specializedParameter.name, programAnalysis.evalConstFromType(instantiationArg, parent));
                continue;
            }
            if (specializationArg.kind === AstKind.NAME) {
                const normalizedName =
                    instantiationArg.kind === AstKind.NAME
                        ? instantiationArg.name
                        : instantiationArg.kind === AstKind.TEMPLATE_INSTANCE
                          ? instantiationArg.name
                          : "";
                if (normalizedName !== specializationArg.name) {
                    match = false;
                    break;
                }
                continue;
            }
            if (programAnalysis.evalConstFromType(instantiationArg, parent) !== programAnalysis.evalConstFromType(specializationArg, parent)) {
                match = false;
                break;
            }
        }
        if (match)
            return {
                templateDeclaration: specialization.templateDeclaration,
                b: programAnalysis.withStaticConsts(specialization.templateDeclaration, templateBindings),
            };
    }
    return null;
}

export function instantiateTemplateBindings(
    programAnalysis: ProgramAnalysis,
    templateDeclaration: ClassTemplate,
    resolvedArguments: TypeSpec[],
    parent: TemplateBindings,
): TemplateBindings {
    const templateBindings: TemplateBindings = {
        types: new Map(),
        values: new Map(),
        structs: new Map(parent.structs),
    };
    for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
        const templateParam = templateDeclaration.params[parameterIndex];
        const argument =
            resolvedArguments[parameterIndex] ??
            (templateParam.kind === AstKind.TYPE && templateParam.default
                ? programAnalysis.substInBindings(templateParam.default, templateBindings)
                : templateParam.kind === AstKind.NON_TYPE_DEFAULT
                  ? ({ kind: AstKind.EXPR_VALUE, expression: templateParam.default } as TypeSpec)
                  : undefined);
        if (!argument) continue;
        if (templateParam.kind === AstKind.TYPE) templateBindings.types.set(templateParam.name, argument);
        else templateBindings.values.set(templateParam.name, programAnalysis.evalConstFromType(argument, parent));
    }
    return templateBindings;
}

export function withStaticConsts(programAnalysis: ProgramAnalysis, templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings {
    for (const member of templateDeclaration.members) {
        if (member.kind !== AstKind.VARIABLE) continue;
        const variableDeclaration = member as VariableDecl;
        if (
            (variableDeclaration.isStatic || variableDeclaration.isConstexpr) &&
            variableDeclaration.initializer &&
            !templateBindings.values.has(variableDeclaration.name)
        ) {
            try {
                templateBindings.values.set(variableDeclaration.name, programAnalysis.evalConstBig(variableDeclaration.initializer, templateBindings));
            } catch {
                /* non-integer constexpr (e.g. a typedef selector flag) — not a dimension */
            }
        }
    }
    return templateBindings;
}

export function layoutOfTemplate(programAnalysis: ProgramAnalysis, name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout {
    const inst = programAnalysis.instantiateTemplate(name, callArguments, parent);
    const resolved = callArguments.map((argument) => programAnalysis.resolveType(argument, parent));
    if (!inst) {
        return programAnalysis.fallbackTemplateLayout(name, resolved, parent);
    }
    return programAnalysis.layoutOfMembers(
        inst.templateDeclaration.members,
        inst.b,
        `${name}<${resolved.map((resolvedItem) => programAnalysis.typeKey(resolvedItem)).join(",")}>`,
        false,
        inst.templateDeclaration.bases,
    );
}

export function withLocalStructs(members: Declaration[], templateBindings: TemplateBindings): TemplateBindings {
    let structs = templateBindings.structs;
    for (const member of members) {
        if (member.kind === AstKind.STRUCT && (member as StructDecl).name && (member as StructDecl).hasBody !== false) {
            if (structs === templateBindings.structs) structs = new Map(templateBindings.structs);
            structs.set((member as StructDecl).name, member as StructDecl);
        }
    }
    return structs === templateBindings.structs ? templateBindings : { types: templateBindings.types, values: templateBindings.values, structs };
}

export function inlineNestedStruct(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings): TypeSpec {
    const bare = type.kind === AstKind.CONST ? type.valueType : type;
    if (bare.kind === AstKind.NAME) {
        const structDeclaration = templateBindings.structs.get(bare.name);
        if (structDeclaration) return { kind: AstKind.INLINE_STRUCT, struct: structDeclaration };
        // Resolve dependent nested types under the active template bindings.
        const qn = programAnalysis.qualifiedNestedType(bare.name, templateBindings);
        if (qn) return qn;
    }
    return type;
}

export function fallbackTemplateLayout(
    programAnalysis: ProgramAnalysis,
    name: string,
    callArguments: TypeSpec[],
    _templateBindings: TemplateBindings,
): StructLayout {
    const rendered = callArguments.map((argument) => programAnalysis.typeKey(argument)).join(", ");
    throw new Error(`template '${name}<${rendered}>' was not captured from core source; refusing an approximate layout`);
}

export function bindContainer(
    programAnalysis: ProgramAnalysis,
    name: string,
    callArguments: TypeSpec[],
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
): TemplateBindings {
    const templateDeclaration = programAnalysis.templates.get(name);
    const out: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
    if (!templateDeclaration) return out;
    const resolved = callArguments.map((argument) => programAnalysis.resolveType(argument, templateBindings));
    const instanceArguments: TypeSpec[] = [];
    for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
        const parameter = templateDeclaration.params[parameterIndex];
        const parameterArgument =
            resolved[parameterIndex] ??
            (parameter.kind === AstKind.TYPE && parameter.default
                ? programAnalysis.substInBindings(parameter.default, out)
                : parameter.kind === AstKind.NON_TYPE_DEFAULT
                  ? ({ kind: AstKind.EXPR_VALUE, expression: parameter.default } as TypeSpec)
                  : undefined);
        if (!parameterArgument) continue;
        instanceArguments.push(parameterArgument);
        if (parameter.kind === AstKind.TYPE) out.types.set(parameter.name, parameterArgument);
        else out.values.set(parameter.name, programAnalysis.evalConstFromType(parameterArgument, templateBindings));
    }
    // Inside its own body a class template's bare name is the instantiation being compiled, so bind
    // it like any other name: `const Key&` in Key<T> means `const Key<T>&`.
    if (!out.types.has(name)) out.types.set(name, { kind: AstKind.TEMPLATE_INSTANCE, name, callArguments: instanceArguments });
    for (const member of templateDeclaration.members) {
        if (member.kind === AstKind.STRUCT && (member as StructDecl).name && (member as StructDecl).hasBody !== false)
            out.structs.set((member as StructDecl).name, member as StructDecl);
        else if (member.kind === AstKind.TYPEDEF_DECL && !out.types.has((member as any).name)) out.types.set((member as any).name, (member as any).type);
    }
    // Evaluate static constexpr members needed by dependent array sizes.
    for (const templateMember of templateDeclaration.members) {
        if (templateMember.kind !== AstKind.VARIABLE) continue;
        const variableDeclaration = templateMember as VariableDecl;
        if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer && !out.values.has(variableDeclaration.name)) {
            try {
                out.values.set(variableDeclaration.name, programAnalysis.evalConstBig(variableDeclaration.initializer, out));
            } catch {
                /* a const that can't be evaluated under these bindings is simply omitted */
            }
        }
    }
    return out;
}

export function staticConstsOf(programAnalysis: ProgramAnalysis, name: string, templateBindings: TemplateBindings): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const templateDeclaration = programAnalysis.templates.get(name);
    if (!templateDeclaration) return out;
    for (const member of templateDeclaration.members) {
        if (member.kind === AstKind.VARIABLE) {
            const variableDeclaration = member as VariableDecl;
            if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer)
                out.set(variableDeclaration.name, programAnalysis.evalConstBig(variableDeclaration.initializer, templateBindings));
        }
    }
    return out;
}
