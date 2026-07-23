import { AstKind } from "../enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, FieldLayout } from "./types";
import type { TypeSpec, Declaration, VariableDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function alignOfTypeB(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings): number {
    if (type.kind === AstKind.CONST)
        return context.alignOfTypeB(type.valueType, templateBindings);
    if (type.kind === AstKind.REFERENCE || type.kind === AstKind.POINTER)
        return 4;
    if (type.kind === AstKind.ARRAY)
        return context.alignOfTypeB(type.element, templateBindings);
    if (type.kind === AstKind.INLINE_STRUCT) {
        // Reuse cached aggregate alignment to avoid another recursive layout walk.
        return context.layoutOfStruct(type.struct, templateBindings).align;
    }
    if (type.kind === AstKind.NAME) {
        return context.alignOfNameType(type.name, templateBindings);
    }
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        if (type.name === "Array") {
            const elementType = type.callArguments[0];
            return Math.min(context.alignOfTypeB(elementType, templateBindings), 8);
        }
        if (context.templates.get(type.name))
            return context.layoutOfTemplate(type.name, type.callArguments, templateBindings).align;
        return 8;
    }
    if (type.kind === AstKind.DEPENDENT_MEMBER) {
        const resolvedMember = context.resolveDependentMember(type, templateBindings);
        return resolvedMember ? context.alignOfTypeB(resolvedMember.type, resolvedMember.bindings) : 1;
    }
    return 8;
}

export function alignOfNameType(context: ProgramAnalysisInternals, typeName: string, templateBindings: TemplateBindings): number {
    const boundType = templateBindings.types.get(typeName);
    if (boundType)
        return context.alignOfTypeB(boundType, templateBindings);
    const scalarSize = SCALAR_SIZE[typeName];
    if (scalarSize !== undefined)
        return Math.min(scalarSize, 8);
    const typedefType = context.typedefs.get(typeName);
    if (typedefType)
        return context.alignOfTypeB(typedefType, templateBindings);
    const resolvedStruct = context.structByName(typeName, templateBindings);
    if (resolvedStruct)
        return context.layoutOfStruct(resolvedStruct, templateBindings).align;
    const qualifiedNested = context.qualifiedNestedType(typeName, templateBindings);
    if (qualifiedNested)
        return context.alignOfTypeB(qualifiedNested, templateBindings);
    const enumAlignment = context.enumSize.get(typeName) ?? context.enumSize.get(typeName.split("::").pop()!);
    return enumAlignment ?? 4;
}

export function structAlign(context: ProgramAnalysisInternals, members: Declaration[], templateBindings: TemplateBindings): number {
    if (context.alignDepth > 80)
        return 8;
    context.alignDepth++;
    try {
        let argument = 1;
        for (const member of members) {
            if (member.kind === AstKind.VARIABLE &&
                !(member as VariableDecl).isStatic &&
                !(member as VariableDecl).isConstexpr) {
                argument = Math.max(argument, context.alignOfTypeB((member as VariableDecl).type, templateBindings));
            }
        }
        return Math.min(argument, 8);
    }
    finally {
        context.alignDepth--;
    }
}

export function alignUp(context: ProgramAnalysisInternals, count: number, argument: number): number {
    return Math.ceil(count / argument) * argument;
}

export function alignOfType(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    return context.alignOfTypeB(type, templateBindings);
}

export function layoutOfType(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout | null {
    if (type.kind === AstKind.CONST)
        return context.layoutOfType(type.valueType, templateBindings);
    if (type.kind === AstKind.INLINE_STRUCT)
        return context.layoutOfStruct(type.struct, templateBindings);
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        return context.templates.get(type.name) ? context.layoutOfTemplate(type.name, type.callArguments, templateBindings) : null;
    }
    if (type.kind === AstKind.NAME) {
        const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
        const bound = templateBindings.types.get(type.name) ?? templateBindings.types.get(baseName);
        if (bound)
            return context.layoutOfType(bound, templateBindings);
        if (SCALAR_SIZE[type.name] !== undefined || SCALAR_SIZE[baseName] !== undefined)
            return null;
        const td = context.typedefs.get(type.name) ?? context.typedefs.get(baseName);
        if (td)
            return context.layoutOfType(td, templateBindings);
        const structDeclaration = context.structByName(type.name, templateBindings);
        if (structDeclaration)
            return context.layoutOfStruct(structDeclaration, templateBindings);
        const qn = context.qualifiedNestedType(type.name, templateBindings);
        if (qn)
            return context.layoutOfType(qn, templateBindings);
    }
    return null;
}

export function fieldOf(context: ProgramAnalysisInternals, type: TypeSpec, member: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): FieldLayout | null {
    const layout = context.layoutOfType(type, templateBindings);
    return layout ? (layout.fields.get(member) ?? null) : null;
}
