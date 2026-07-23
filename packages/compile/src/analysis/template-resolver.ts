import { AstKind } from "../enums";
import { ClassTemplate, StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, Declaration, StructDecl, VariableDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function instantiateTemplate(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], parent: TemplateBindings): {
    templateDeclaration: ClassTemplate;
    b: TemplateBindings;
} | null {
    const resolvedArguments = callArguments.map((argument) => context.resolveType(argument, parent));
    const templateDeclaration = context.templates.get(name) ??
        (name.includes("::") ? context.templates.get(name.slice(name.lastIndexOf("::") + 2)) : undefined);
    if (!templateDeclaration)
        return null;
    const specialization = context.matchTemplateSpecialization(name, resolvedArguments, parent);
    if (specialization)
        return specialization;
    const templateBindings = context.instantiateTemplateBindings(templateDeclaration, resolvedArguments, parent);
    return {
        templateDeclaration,
        b: context.withStaticConsts(templateDeclaration, templateBindings),
    };
}

export function matchTemplateSpecialization(context: ProgramAnalysisInternals, name: string, resolvedArguments: TypeSpec[], parent: TemplateBindings): {
    templateDeclaration: ClassTemplate;
    b: TemplateBindings;
} | null {
    const specializations = context.specializations.get(name);
    if (!specializations)
        return null;
    for (const specialization of specializations) {
        if (specialization.specArgs.length !== resolvedArguments.length)
            continue;
        const paramByName = new Map(specialization.templateDeclaration.params.map((parameter) => [parameter.name, parameter] as const));
        const templateBindings: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
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
                templateBindings.values.set(specializedParameter.name, context.evalConstFromType(instantiationArg, parent));
                continue;
            }
            if (specializationArg.kind === AstKind.NAME) {
                const normalizedName = instantiationArg.kind === AstKind.NAME
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
            if (context.evalConstFromType(instantiationArg, parent) !== context.evalConstFromType(specializationArg, parent)) {
                match = false;
                break;
            }
        }
        if (match)
            return { templateDeclaration: specialization.templateDeclaration, b: context.withStaticConsts(specialization.templateDeclaration, templateBindings) };
    }
    return null;
}

export function instantiateTemplateBindings(context: ProgramAnalysisInternals, templateDeclaration: ClassTemplate, resolvedArguments: TypeSpec[], parent: TemplateBindings): TemplateBindings {
    const templateBindings: TemplateBindings = {
        types: new Map(),
        values: new Map(),
        structs: new Map(),
    };
    for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
        const templateParam = templateDeclaration.params[parameterIndex];
        const argument = resolvedArguments[parameterIndex] ??
            (templateParam.kind === AstKind.TYPE && templateParam.default
                ? context.substInBindings(templateParam.default, templateBindings)
                : templateParam.kind === AstKind.NON_TYPE_DEFAULT
                    ? ({ kind: AstKind.EXPR_VALUE, expression: templateParam.default } as TypeSpec)
                    : undefined);
        if (!argument)
            continue;
        if (templateParam.kind === AstKind.TYPE)
            templateBindings.types.set(templateParam.name, argument);
        else
            templateBindings.values.set(templateParam.name, context.evalConstFromType(argument, parent));
    }
    return templateBindings;
}

export function withStaticConsts(context: ProgramAnalysisInternals, templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings {
    for (const member of templateDeclaration.members) {
        if (member.kind !== AstKind.VARIABLE)
            continue;
        const variableDeclaration = member as VariableDecl;
        if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer && !templateBindings.values.has(variableDeclaration.name)) {
            try {
                templateBindings.values.set(variableDeclaration.name, context.evalConstBig(variableDeclaration.initializer, templateBindings));
            }
            catch {
                /* non-integer constexpr (e.g. a typedef selector flag) — not a dimension */
            }
        }
    }
    return templateBindings;
}

export function layoutOfTemplate(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout {
    const inst = context.instantiateTemplate(name, callArguments, parent);
    const resolved = callArguments.map((argument) => context.resolveType(argument, parent));
    if (!inst) {
        return context.fallbackTemplateLayout(name, resolved, parent);
    }
    return context.layoutOfMembers(inst.templateDeclaration.members, inst.b, `${name}<${resolved.map((resolvedItem) => context.typeKey(resolvedItem)).join(",")}>`, false, inst.templateDeclaration.bases);
}

export function withLocalStructs(context: ProgramAnalysisInternals, members: Declaration[], templateBindings: TemplateBindings): TemplateBindings {
    let structs = templateBindings.structs;
    for (const member of members) {
        if (member.kind === AstKind.STRUCT && (member as StructDecl).name) {
            if (structs === templateBindings.structs)
                structs = new Map(templateBindings.structs);
            structs.set((member as StructDecl).name, member as StructDecl);
        }
    }
    return structs === templateBindings.structs ? templateBindings : { types: templateBindings.types, values: templateBindings.values, structs };
}

export function inlineNestedStruct(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings): TypeSpec {
    const bare = type.kind === AstKind.CONST ? type.valueType : type;
    if (bare.kind === AstKind.NAME) {
        const structDeclaration = templateBindings.structs.get(bare.name);
        if (structDeclaration)
            return { kind: AstKind.INLINE_STRUCT, struct: structDeclaration };
        // Resolve dependent nested types under the active template bindings.
        const qn = context.qualifiedNestedType(bare.name, templateBindings);
        if (qn)
            return qn;
    }
    return type;
}

export function fallbackTemplateLayout(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings): StructLayout {
    const rendered = callArguments.map((argument) => context.typeKey(argument)).join(", ");
    throw new Error(`template '${name}<${rendered}>' was not captured from core source; refusing an approximate layout`);
}

export function bindContainer(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): TemplateBindings {
    const templateDeclaration = context.templates.get(name);
    const out: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
    if (!templateDeclaration)
        return out;
    const resolved = callArguments.map((argument) => context.resolveType(argument, templateBindings));
    for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
        const parameter = templateDeclaration.params[parameterIndex];
        const parameterArgument = resolved[parameterIndex] ??
            (parameter.kind === AstKind.TYPE && parameter.default
                ? context.substInBindings(parameter.default, out)
                : parameter.kind === AstKind.NON_TYPE_DEFAULT
                    ? ({ kind: AstKind.EXPR_VALUE, expression: parameter.default } as TypeSpec)
                    : undefined);
        if (!parameterArgument)
            continue;
        if (parameter.kind === AstKind.TYPE)
            out.types.set(parameter.name, parameterArgument);
        else
            out.values.set(parameter.name, context.evalConstFromType(parameterArgument, templateBindings));
    }
    for (const member of templateDeclaration.members) {
        if (member.kind === AstKind.STRUCT && (member as StructDecl).name)
            out.structs.set((member as StructDecl).name, member as StructDecl);
        else if (member.kind === AstKind.TYPEDEF_DECL && !out.types.has((member as any).name))
            out.types.set((member as any).name, (member as any).type);
    }
    // Evaluate static constexpr members needed by dependent array sizes.
    for (const templateMember of templateDeclaration.members) {
        if (templateMember.kind !== AstKind.VARIABLE)
            continue;
        const variableDeclaration = templateMember as VariableDecl;
        if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer && !out.values.has(variableDeclaration.name)) {
            try {
                out.values.set(variableDeclaration.name, context.evalConstBig(variableDeclaration.initializer, out));
            }
            catch {
                /* a const that can't be evaluated under these bindings is simply omitted */
            }
        }
    }
    return out;
}

export function staticConstsOf(context: ProgramAnalysisInternals, name: string, templateBindings: TemplateBindings): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const templateDeclaration = context.templates.get(name);
    if (!templateDeclaration)
        return out;
    for (const member of templateDeclaration.members) {
        if (member.kind === AstKind.VARIABLE) {
            const variableDeclaration = member as VariableDecl;
            if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer)
                out.set(variableDeclaration.name, context.evalConstBig(variableDeclaration.initializer, templateBindings));
        }
    }
    return out;
}
