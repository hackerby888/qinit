import { AstKind } from "../shared/enums";
import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, FieldLayout } from "./types";
import type { TypeSpec, Declaration, StructDecl, VariableDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

function emptyStructIdentity(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec,
    templateBindings: TemplateBindings,
): StructDecl | string | null {
    let resolved = programAnalysis.substInBindings(type, templateBindings);
    while (resolved.kind === AstKind.CONST) resolved = resolved.valueType;
    if (resolved.kind === AstKind.TEMPLATE_INSTANCE)
        return `template:${programAnalysis.typeKey(resolved)}`;
    if (resolved.kind !== AstKind.NAME && resolved.kind !== AstKind.INLINE_STRUCT) return null;
    return programAnalysis.structOf(resolved, templateBindings);
}

export function layoutOf(programAnalysis: ProgramAnalysis, struct: StructDecl): StructLayout {
    return programAnalysis.layoutOfStruct(struct, EMPTY_TEMPLATE_BINDINGS);
}

export function baseContribution(
    programAnalysis: ProgramAnalysis,
    baseType: TypeSpec,
    parentB: TemplateBindings,
): {
    layout: StructLayout;
    consts: Map<string, bigint>;
} | null {
    let resolvedBaseType: TypeSpec = baseType;
    if (resolvedBaseType.kind === AstKind.NAME) {
        const bound = parentB.types.get(resolvedBaseType.name);
        if (bound) resolvedBaseType = bound;
        else {
            const td = programAnalysis.typedefs.get(resolvedBaseType.name);
            if (td) resolvedBaseType = td;
        }
    }
    if (resolvedBaseType.kind === AstKind.TEMPLATE_INSTANCE) {
        const templateDeclaration = programAnalysis.templates.get(resolvedBaseType.name);
        if (!templateDeclaration)
            return {
                layout: programAnalysis.layoutOfTemplate(
                    resolvedBaseType.name,
                    resolvedBaseType.callArguments,
                    parentB,
                ),
                consts: new Map(),
            };
        const templateBindings: TemplateBindings = {
            types: new Map(),
            values: new Map(),
            structs: new Map(),
        };
        const resolved = resolvedBaseType.callArguments.map((argument) =>
            programAnalysis.resolveType(argument, parentB),
        );
        for (
            let parameterIndex = 0;
            parameterIndex < templateDeclaration.params.length;
            parameterIndex++
        ) {
            const parameter = templateDeclaration.params[parameterIndex];
            const argument = resolved[parameterIndex];
            if (!argument) continue;
            if (parameter.kind === AstKind.TYPE)
                templateBindings.types.set(parameter.name, argument);
            else
                templateBindings.values.set(
                    parameter.name,
                    programAnalysis.evalConstFromType(argument, parentB),
                );
        }
        const consts = new Map<string, bigint>();
        for (const member of templateDeclaration.members) {
            if (member.kind !== AstKind.VARIABLE) continue;
            const variableDeclaration = member as VariableDecl;
            if (
                (variableDeclaration.isStatic || variableDeclaration.isConstexpr) &&
                variableDeclaration.initializer &&
                !templateBindings.values.has(variableDeclaration.name)
            ) {
                try {
                    const val = programAnalysis.evalConstBig(
                        variableDeclaration.initializer,
                        templateBindings,
                    );
                    templateBindings.values.set(variableDeclaration.name, val);
                    consts.set(variableDeclaration.name, val);
                } catch {
                    /* a non-integer static constexpr (e.g. a bool selector) — not a dimension */
                }
            }
        }
        const layout = programAnalysis.layoutOfMembers(
            templateDeclaration.members,
            templateBindings,
            `${resolvedBaseType.name}<${resolved.map((resolvedItem) => programAnalysis.typeKey(resolvedItem)).join(",")}>`,
            false,
            templateDeclaration.bases,
        );
        return { layout, consts };
    }
    if (resolvedBaseType.kind === AstKind.NAME) {
        const struct = programAnalysis.structByName(resolvedBaseType.name, parentB);
        if (struct) {
            const consts = new Map<string, bigint>();
            for (const member of struct.members) {
                if (member.kind !== AstKind.VARIABLE) continue;
                const variableDeclaration = member as VariableDecl;
                if (
                    (variableDeclaration.isStatic || variableDeclaration.isConstexpr) &&
                    variableDeclaration.initializer
                ) {
                    try {
                        consts.set(
                            variableDeclaration.name,
                            programAnalysis.evalConstBig(variableDeclaration.initializer, parentB),
                        );
                    } catch {
                        /* not a dimension */
                    }
                }
            }
            const layout = programAnalysis.layoutOfStruct(struct, parentB);
            return { layout, consts };
        }
    }
    return null;
}

export function evalQualifiedConst(
    programAnalysis: ProgramAnalysis,
    typeName: string,
    member: string,
    templateBindings: TemplateBindings,
): bigint | null {
    const type = programAnalysis.resolveType(
        { kind: AstKind.NAME, name: typeName },
        templateBindings,
    );
    let members: Declaration[] | null = null;
    let tb: TemplateBindings = templateBindings;
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        const inst = programAnalysis.instantiateTemplate(
            type.name,
            type.callArguments,
            templateBindings,
        );
        if (!inst) return null;
        members = inst.templateDeclaration.members;
        tb = inst.b;
    } else if (type.kind === AstKind.INLINE_STRUCT) {
        members = type.struct.members;
    } else if (type.kind === AstKind.NAME) {
        const structDeclaration = programAnalysis.structByName(type.name, templateBindings);
        if (!structDeclaration) return null;
        members = structDeclaration.members;
    }
    if (!members) return null;
    for (const memberDeclaration of members) {
        if (memberDeclaration.kind !== AstKind.VARIABLE) continue;
        const variableDeclaration = memberDeclaration as VariableDecl;
        if (variableDeclaration.name === member && variableDeclaration.initializer) {
            try {
                return programAnalysis.evalConstBig(variableDeclaration.initializer, tb);
            } catch {
                return null;
            }
        }
    }
    return null;
}

export function structCacheKey(programAnalysis: ProgramAnalysis, struct: StructDecl): string {
    let cacheKey = programAnalysis.structKeys.get(struct);
    if (cacheKey === undefined) {
        cacheKey = `${struct.name}#${programAnalysis.structKeyCounter++}`;
        programAnalysis.structKeys.set(struct, cacheKey);
    }
    return cacheKey;
}

export function layoutOfStruct(
    programAnalysis: ProgramAnalysis,
    struct: StructDecl,
    templateBindings: TemplateBindings,
): StructLayout {
    if (struct.hasBody === false) return { size: 0, align: 1, fields: new Map() };
    return programAnalysis.layoutOfMembers(
        struct.members,
        templateBindings,
        programAnalysis.structCacheKey(struct),
        struct.isUnion,
        struct.bases,
    );
}

export function bindingSig(
    programAnalysis: ProgramAnalysis,
    templateBindings: TemplateBindings,
): string {
    const bindingCount =
        templateBindings.types.size + templateBindings.values.size + templateBindings.structs.size;
    if (bindingCount === 0) return "";
    const typeBindingSignature = [...templateBindings.types]
        .map(([name, type]) => `${name}=${programAnalysis.typeKey(type)}`)
        .join(",");
    const valueBindingSignature = [...templateBindings.values]
        .map(([name, value]) => `${name}=${value}`)
        .join(",");
    const structBindingSignature = [...templateBindings.structs]
        .map(([name, struct]) => `${name}=${programAnalysis.structCacheKey(struct)}`)
        .join(",");
    return `|${typeBindingSignature}|${valueBindingSignature}|${structBindingSignature}`;
}

export function layoutOfMembers(
    programAnalysis: ProgramAnalysis,
    members: Declaration[],
    bIn: TemplateBindings,
    cacheKey: string,
    isUnion = false,
    bases: TypeSpec[] = [],
): StructLayout {
    // Cache each concrete binding once to avoid recursive layout blowups.
    const key = cacheKey ? cacheKey + programAnalysis.bindingSig(bIn) : "";
    if (key) {
        const cached = programAnalysis.layoutCache.get(key);
        if (cached) return cached;
        // Cycle breaker: a type reachable from its own field returns an empty back-edge layout.
        if (programAnalysis.inProgress.has(key)) return { size: 0, align: 1, fields: new Map() };
        programAnalysis.inProgress.add(key);
    }
    try {
        const templateBindings = programAnalysis.withLocalStructs(members, bIn);
        const fields = new Map<string, FieldLayout>();
        let offset = 0;
        let maxAlign = 1;
        if (isUnion) {
            let max = 0;
            for (const member of members) {
                if (member.kind === AstKind.VARIABLE) {
                    const variableDeclaration = member as VariableDecl;
                    if (variableDeclaration.isStatic || variableDeclaration.isConstexpr) continue;
                    const byteSize = programAnalysis.sizeOfType(
                        variableDeclaration.type,
                        templateBindings,
                    );
                    const align = programAnalysis.alignOfTypeB(
                        variableDeclaration.type,
                        templateBindings,
                    );
                    fields.set(variableDeclaration.name, {
                        name: variableDeclaration.name,
                        offset: 0,
                        size: byteSize,
                        type: programAnalysis.inlineNestedStruct(
                            variableDeclaration.type,
                            templateBindings,
                        ),
                    });
                    if (byteSize > max) max = byteSize;
                    if (align > maxAlign) maxAlign = align;
                }
            }
            const layout = {
                size: fields.size === 0 ? 1 : programAnalysis.alignUp(max, maxAlign),
                align: maxAlign,
                fields,
            };
            if (key) programAnalysis.layoutCache.set(key, layout);
            return layout;
        }
        // Place base-class fields first and inherit their static constants.
        let memberVals = templateBindings.values;
        const zeroOffsetEmptyStructs = new Set<StructDecl | string>();
        for (const baseType of bases) {
            const baseContribution = programAnalysis.baseContribution(baseType, templateBindings);
            if (!baseContribution) continue;
            offset = programAnalysis.alignUp(offset, baseContribution.layout.align);
            const baseOffset = offset;
            for (const baseField of baseContribution.layout.fields.values()) {
                fields.set(baseField.name, {
                    name: baseField.name,
                    offset: offset + baseField.offset,
                    size: baseField.size,
                    type: baseField.type,
                });
            }
            if (baseContribution.layout.fields.size > 0) offset += baseContribution.layout.size;
            else if (baseContribution.layout.size > 0) {
                const baseIdentity = emptyStructIdentity(
                    programAnalysis,
                    baseType,
                    templateBindings,
                );
                if (baseIdentity) zeroOffsetEmptyStructs.add(baseIdentity);
            }
            if (baseOffset === 0 || baseContribution.layout.fields.size === 0) {
                for (const identity of baseContribution.layout.zeroOffsetEmptyStructs ?? [])
                    zeroOffsetEmptyStructs.add(identity);
            }
            if (baseContribution.layout.align > maxAlign) maxAlign = baseContribution.layout.align;
            if (baseContribution.consts.size) {
                if (memberVals === templateBindings.values)
                    memberVals = new Map(templateBindings.values);
                for (const [baseConstName, baseConstValue] of baseContribution.consts)
                    if (!memberVals.has(baseConstName))
                        memberVals.set(baseConstName, baseConstValue);
            }
        }
        // Add nested typedefs to the member binding scope.
        let memberTypes = templateBindings.types;
        for (const member of members) {
            if (member.kind !== AstKind.TYPEDEF_DECL) continue;
            const td = member as any;
            if (memberTypes === templateBindings.types)
                memberTypes = new Map(templateBindings.types);
            if (!memberTypes.has(td.name)) memberTypes.set(td.name, td.type);
        }
        const bMem =
            memberVals === templateBindings.values && memberTypes === templateBindings.types
                ? templateBindings
                : { types: memberTypes, values: memberVals, structs: templateBindings.structs };
        for (const memberDeclaration of members) {
            // Promote anonymous struct and union members at the current offset.
            if (
                memberDeclaration.kind === AstKind.STRUCT &&
                !(memberDeclaration as StructDecl).name
            ) {
                const sub = programAnalysis.layoutOfStruct(memberDeclaration as StructDecl, bMem);
                offset = programAnalysis.alignUp(offset, sub.align);
                for (const inheritedField of sub.fields.values())
                    fields.set(inheritedField.name, {
                        name: inheritedField.name,
                        offset: offset + inheritedField.offset,
                        size: inheritedField.size,
                        type: inheritedField.type,
                    });
                offset += sub.size;
                if (sub.align > maxAlign) maxAlign = sub.align;
                continue;
            }
            if (memberDeclaration.kind !== AstKind.VARIABLE) continue;
            const variableDeclaration = memberDeclaration as VariableDecl;
            if (variableDeclaration.isStatic || variableDeclaration.isConstexpr) continue;
            const byteSize = programAnalysis.sizeOfType(variableDeclaration.type, bMem);
            const align = Math.min(programAnalysis.alignOfTypeB(variableDeclaration.type, bMem), 8);
            offset = programAnalysis.alignUp(offset, align);
            const memberIdentity = emptyStructIdentity(
                programAnalysis,
                variableDeclaration.type,
                bMem,
            );
            if (offset === 0 && memberIdentity && zeroOffsetEmptyStructs.has(memberIdentity))
                offset = programAnalysis.alignUp(1, align);
            fields.set(variableDeclaration.name, {
                name: variableDeclaration.name,
                offset,
                size: byteSize,
                type: programAnalysis.inlineNestedStruct(variableDeclaration.type, bMem),
            });
            offset += byteSize;
            if (align > maxAlign) maxAlign = align;
        }
        const size = fields.size === 0 ? 1 : programAnalysis.alignUp(offset, maxAlign);
        const layout: StructLayout = { size, align: maxAlign, fields };
        if (zeroOffsetEmptyStructs.size) layout.zeroOffsetEmptyStructs = zeroOffsetEmptyStructs;
        if (key) programAnalysis.layoutCache.set(key, layout);
        return layout;
    } finally {
        if (key) programAnalysis.inProgress.delete(key);
    }
}
