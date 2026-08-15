import { AstKind } from "../shared/enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, FieldLayout } from "./types";
import type { TypeSpec, Declaration, VariableDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function alignOfTypeB(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings): number {
    if (type.kind === AstKind.CONST) return programAnalysis.alignOfTypeB(type.valueType, templateBindings);
    if (type.kind === AstKind.REFERENCE || type.kind === AstKind.POINTER) return 4;
    if (type.kind === AstKind.ARRAY) return programAnalysis.alignOfTypeB(type.element, templateBindings);
    if (type.kind === AstKind.INLINE_STRUCT) {
        // Reuse cached aggregate alignment to avoid another recursive layout walk.
        return programAnalysis.layoutOfStruct(type.struct, templateBindings).align;
    }
    if (type.kind === AstKind.NAME) {
        return programAnalysis.alignOfNameType(type.name, templateBindings);
    }
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        if (type.name === "Array") {
            const elementType = type.callArguments[0];
            return Math.min(programAnalysis.alignOfTypeB(elementType, templateBindings), 8);
        }
        if (programAnalysis.templates.get(type.name)) return programAnalysis.layoutOfTemplate(type.name, type.callArguments, templateBindings).align;
        return 8;
    }
    if (type.kind === AstKind.DEPENDENT_MEMBER) {
        const resolvedMember = programAnalysis.resolveDependentMember(type, templateBindings);
        return resolvedMember ? programAnalysis.alignOfTypeB(resolvedMember.type, resolvedMember.bindings) : 1;
    }
    return 8;
}

export function alignOfNameType(programAnalysis: ProgramAnalysis, typeName: string, templateBindings: TemplateBindings): number {
    const boundType = templateBindings.types.get(typeName);
    if (boundType) return programAnalysis.alignOfTypeB(boundType, templateBindings);
    const scalarSize = SCALAR_SIZE[typeName];
    if (scalarSize !== undefined) return Math.min(scalarSize, 8);
    const typedefType = programAnalysis.typedefs.get(typeName);
    if (typedefType) return programAnalysis.alignOfTypeB(typedefType, templateBindings);
    const resolvedStruct = programAnalysis.structByName(typeName, templateBindings);
    if (resolvedStruct) return programAnalysis.layoutOfStruct(resolvedStruct, templateBindings).align;
    const qualifiedNested = programAnalysis.qualifiedNestedType(typeName, templateBindings);
    if (qualifiedNested) return programAnalysis.alignOfTypeB(qualifiedNested, templateBindings);
    const enumAlignment = programAnalysis.enumSize.get(typeName) ?? programAnalysis.enumSize.get(typeName.split("::").pop()!);
    return enumAlignment ?? 4;
}

export function structAlign(programAnalysis: ProgramAnalysis, members: Declaration[], templateBindings: TemplateBindings): number {
    if (programAnalysis.alignDepth > 80) return 8;
    programAnalysis.alignDepth++;
    try {
        let maximumAlignment = 1;
        for (const member of members) {
            if (member.kind === AstKind.VARIABLE && !(member as VariableDecl).isStatic && !(member as VariableDecl).isConstexpr) {
                maximumAlignment = Math.max(maximumAlignment, programAnalysis.alignOfTypeB((member as VariableDecl).type, templateBindings));
            }
        }
        return Math.min(maximumAlignment, 8);
    } finally {
        programAnalysis.alignDepth--;
    }
}

export function alignUp(_programAnalysis: ProgramAnalysis, value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

export function alignOfType(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    return programAnalysis.alignOfTypeB(type, templateBindings);
}

export function layoutOfType(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec,
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
): StructLayout | null {
    if (type.kind === AstKind.CONST) return programAnalysis.layoutOfType(type.valueType, templateBindings);
    if (type.kind === AstKind.INLINE_STRUCT) return programAnalysis.layoutOfStruct(type.struct, templateBindings);
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        return programAnalysis.templates.get(type.name) ? programAnalysis.layoutOfTemplate(type.name, type.callArguments, templateBindings) : null;
    }
    if (type.kind === AstKind.NAME) {
        const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
        const bound = templateBindings.types.get(type.name) ?? templateBindings.types.get(baseName);
        if (bound) return programAnalysis.layoutOfType(bound, templateBindings);
        if (SCALAR_SIZE[type.name] !== undefined || SCALAR_SIZE[baseName] !== undefined) return null;
        const td = programAnalysis.typedefs.get(type.name) ?? programAnalysis.typedefs.get(baseName);
        if (td) return programAnalysis.layoutOfType(td, templateBindings);
        const structDeclaration = programAnalysis.structByName(type.name, templateBindings);
        if (structDeclaration) return programAnalysis.layoutOfStruct(structDeclaration, templateBindings);
        const qn = programAnalysis.qualifiedNestedType(type.name, templateBindings);
        if (qn) return programAnalysis.layoutOfType(qn, templateBindings);
    }
    return null;
}

export function fieldOf(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec,
    member: string,
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
): FieldLayout | null {
    const layout = programAnalysis.layoutOfType(type, templateBindings);
    return layout ? (layout.fields.get(member) ?? null) : null;
}
