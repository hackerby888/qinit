import { AstKind } from "../shared/enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { followScopedTypedef, lookupScoped, scopedLookupKeys } from "./declaration-index";
import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, VariableDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function sizeOfType(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    // Guard against recursive/self-referential types (a struct reachable from its own field).
    if (programAnalysis.sizeDepth > 80) {
        programAnalysis.warn("type nesting too deep / recursive — sized as 0", 0);
        return 0;
    }
    programAnalysis.sizeDepth++;
    try {
        return programAnalysis.sizeOfTypeInner(type, templateBindings);
    } finally {
        programAnalysis.sizeDepth--;
    }
}

export function sizeOfTypeInner(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings): number {
    if (type.kind === AstKind.CONST) return programAnalysis.sizeOfType(type.valueType, templateBindings);
    if (type.kind === AstKind.REFERENCE || type.kind === AstKind.POINTER) return 4;
    if (type.kind === AstKind.VOID) return 0;
    if (type.kind === AstKind.ARRAY) {
        const constantValue = programAnalysis.evalConst(type.size, templateBindings);
        return programAnalysis.sizeOfType(type.element, templateBindings) * constantValue;
    }
    if (type.kind === AstKind.INLINE_STRUCT) {
        return programAnalysis.layoutOfStruct(type.struct, templateBindings).size;
    }
    if (type.kind === AstKind.NAME) {
        // template parameter bound to a concrete type?
        const bound = lookupScoped(templateBindings.types, type.name);
        if (bound) return programAnalysis.sizeOfType(bound, templateBindings);
        const size = scopedLookupKeys(type.name)
            .map((key) => SCALAR_SIZE[key])
            .find((scalarSize) => scalarSize !== undefined);
        if (size !== undefined) return size;
        const td = followScopedTypedef(programAnalysis, type.name);
        if (td) return programAnalysis.sizeOfType(td, templateBindings);
        const struct = programAnalysis.structByName(type.name, templateBindings);
        if (struct) return programAnalysis.layoutOfStruct(struct, templateBindings).size;
        const qn = programAnalysis.qualifiedNestedType(type.name, templateBindings);
        if (qn) return programAnalysis.sizeOfType(qn, templateBindings);
        // asset iterators occupy their 8-byte runtime shape (count @0, cursor @4) wherever they live
        if (/Asset(Ownership|Possession)Iterator$/.test(type.name)) return 8;
        // an enum type: sized by its declared underlying type (enum class X : uint8 → 1), default int
        const es = lookupScoped(programAnalysis.enumSize, type.name);
        if (es !== undefined) return es;
        const num = parseInt(type.name);
        if (!isNaN(num)) return num; // shouldn't happen for a type, defensive
        return 4; // assume enum-sized
    }
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        return programAnalysis.layoutOfTemplate(type.name, type.callArguments, templateBindings).size;
    }
    if (type.kind === AstKind.DEPENDENT_MEMBER) {
        const resolvedMember = programAnalysis.resolveDependentMember(type, templateBindings);
        if (resolvedMember) return programAnalysis.sizeOfType(resolvedMember.type, resolvedMember.bindings);
        return 0;
    }
    return 0;
}

export function resolveDependentMember(
    programAnalysis: ProgramAnalysis,
    type: Extract<
        TypeSpec,
        {
            kind: AstKind.DEPENDENT_MEMBER;
        }
    >,
    templateBindings: TemplateBindings,
): {
    type: TypeSpec;
    bindings: TemplateBindings;
} | null {
    const base = type.base;
    if (base.kind !== AstKind.TEMPLATE_INSTANCE) return null;
    const inst = programAnalysis.instantiateTemplate(base.name, base.callArguments, templateBindings);
    if (!inst) return null;
    for (const member of inst.templateDeclaration.members) {
        if (member.kind === AstKind.TYPEDEF_DECL && (member as any).name === type.member) {
            return { type: (member as any).type, bindings: inst.b };
        }
    }
    return null;
}

export function resolveType(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings, depth = 0): TypeSpec {
    if (depth > 24 || type.kind !== AstKind.NAME) return type;
    const bound = templateBindings.types.get(type.name);
    if (bound && !(bound.kind === AstKind.NAME && bound.name === type.name)) {
        return programAnalysis.resolveType(bound, templateBindings, depth + 1);
    }
    const td = followScopedTypedef(programAnalysis, type.name);
    if (td && !(td.kind === AstKind.NAME && td.name === type.name)) {
        return programAnalysis.resolveType(td, templateBindings, depth + 1);
    }
    const qn = programAnalysis.qualifiedNestedType(type.name, templateBindings);
    if (qn) return qn;
    return type;
}

export function concreteMemberType(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec,
    parent: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    },
    depth = 0,
): TypeSpec {
    const inst = programAnalysis.instantiateTemplate(parent.name, parent.callArguments, EMPTY_TEMPLATE_BINDINGS);
    if (!inst) return type;
    const nested = new Map<string, TypeSpec>();
    for (const member of inst.templateDeclaration.members) {
        if (member.kind === AstKind.TYPEDEF_DECL) nested.set((member as any).name, (member as any).type);
    }
    return programAnalysis.resolveInScope(type, inst.b, nested, depth);
}

export function resolveInScope(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec,
    scope: TemplateBindings,
    nested: Map<string, TypeSpec>,
    depth: number,
): TypeSpec {
    if (depth > 24) return type;
    if (type.kind === AstKind.CONST) {
        return {
            kind: AstKind.CONST,
            valueType: programAnalysis.resolveInScope(type.valueType, scope, nested, depth + 1),
        };
    }
    if (type.kind === AstKind.ARRAY) {
        return {
            kind: AstKind.ARRAY,
            element: programAnalysis.resolveInScope(type.element, scope, nested, depth + 1),
            size: type.size,
        };
    }
    if (type.kind === AstKind.NAME) {
        return programAnalysis.resolveNamedTypeInScope(type, scope, nested, depth);
    }
    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        const resolvedCallArguments = programAnalysis.resolveTemplateInstanceArguments(type, scope, nested, depth);
        return {
            kind: AstKind.TEMPLATE_INSTANCE,
            name: type.name,
            callArguments: resolvedCallArguments,
        };
    }
    return type;
}

export function resolveNamedTypeInScope(
    programAnalysis: ProgramAnalysis,
    type: Extract<
        TypeSpec,
        {
            kind: AstKind.NAME;
        }
    >,
    scope: TemplateBindings,
    nested: Map<string, TypeSpec>,
    depth: number,
): TypeSpec {
    const boundType = scope.types.get(type.name);
    if (boundType && !(boundType.kind === AstKind.NAME && boundType.name === type.name))
        return programAnalysis.resolveInScope(boundType, scope, nested, depth + 1);
    const nestedType = nested.get(type.name);
    if (nestedType && !(nestedType.kind === AstKind.NAME && nestedType.name === type.name))
        return programAnalysis.resolveInScope(nestedType, scope, nested, depth + 1);
    const typedefType = followScopedTypedef(programAnalysis, type.name);
    if (typedefType && !(typedefType.kind === AstKind.NAME && typedefType.name === type.name))
        return programAnalysis.resolveInScope(typedefType, scope, nested, depth + 1);
    const qualifiedType = programAnalysis.qualifiedNestedType(type.name, scope);
    if (qualifiedType) return qualifiedType;
    return type;
}

export function resolveTemplateInstanceArguments(
    programAnalysis: ProgramAnalysis,
    type: Extract<
        TypeSpec,
        {
            kind: AstKind.TEMPLATE_INSTANCE;
        }
    >,
    scope: TemplateBindings,
    nested: Map<string, TypeSpec>,
    depth: number,
): TypeSpec[] {
    return type.callArguments.map((argument) => {
        if (argument.kind === AstKind.NAME && scope.values.has(argument.name)) {
            return {
                kind: AstKind.EXPR_VALUE,
                expression: {
                    kind: AstKind.INT_LITERAL,
                    value: scope.values.get(argument.name)!.toString(),
                    span: { start: 0, end: 0, line: 0, column: 0 },
                },
            } as TypeSpec;
        }
        return programAnalysis.resolveInScope(argument, scope, nested, depth + 1);
    });
}

export function substInBindings(programAnalysis: ProgramAnalysis, type: TypeSpec, bind: TemplateBindings): TypeSpec {
    return programAnalysis.resolveInScope(type, bind, new Map(), 0);
}

export function valueOfTypeArg(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint {
    return programAnalysis.evalConstFromType(type, templateBindings);
}

export function evalConstFromType(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings): bigint {
    // A non-type template arg arrives as a TypeSpec; recover its integer value.
    if (type.kind === AstKind.EXPR_VALUE) return programAnalysis.evalConstBig(type.expression, templateBindings);
    if (type.kind === AstKind.NAME) {
        const numericValue = templateBindings.values.get(type.name);
        if (numericValue !== undefined) return numericValue;
        const count = parseInt(type.name);
        if (!isNaN(count)) return BigInt(count);
        // a named constant template arg (e.g. Array<RoundInfo, QEARN_MAX_EPOCHS>)
        const resolvedConstant = programAnalysis.resolveConst(type.name, templateBindings);
        if (resolvedConstant !== null) return resolvedConstant;
    }
    return 0n;
}

export function typeKey(programAnalysis: ProgramAnalysis, type: TypeSpec): string {
    if (type.kind === AstKind.NAME) return type.name;
    if (type.kind === AstKind.TEMPLATE_INSTANCE) return `${type.name}<${type.callArguments.map((argument) => programAnalysis.typeKey(argument)).join(",")}>`;
    if (type.kind === AstKind.CONST) return "c" + programAnalysis.typeKey(type.valueType);
    if (type.kind === AstKind.ARRAY) return `${programAnalysis.typeKey(type.element)}[]`;
    if (type.kind === AstKind.POINTER) return "*";
    if (type.kind === AstKind.EXPR_VALUE) return `#${programAnalysis.evalConst(type.expression)}`;
    // inline-carried struct as a template arg (Array<Order,256> resolved through its declaring scope): key by tag + field names
    if (type.kind === AstKind.INLINE_STRUCT) {
        const fields = type.struct.members
            .filter((member) => member.kind === AstKind.VARIABLE)
            .map((variableDeclaration) => (variableDeclaration as VariableDecl).name)
            .join(",");
        return `s:${type.struct.name || "anon"}{${fields}}`;
    }
    return "?";
}

export function derefType(programAnalysis: ProgramAnalysis, type: TypeSpec): TypeSpec {
    if (type.kind === AstKind.CONST) return programAnalysis.derefType(type.valueType);
    if (type.kind === AstKind.REFERENCE) return programAnalysis.derefType(type.referentType);
    return type;
}

export function isVoidType(programAnalysis: ProgramAnalysis, type: TypeSpec): boolean {
    const dereferencedType = programAnalysis.derefType(type);
    return dereferencedType.kind === AstKind.VOID || (dereferencedType.kind === AstKind.NAME && dereferencedType.name === "void");
}

export function isAggregateType(programAnalysis: ProgramAnalysis, type: TypeSpec): boolean {
    if (type.kind === AstKind.CONST) return programAnalysis.isAggregateType(type.valueType);
    if (type.kind === AstKind.REFERENCE) return programAnalysis.isAggregateType(type.referentType);
    if (type.kind === AstKind.ARRAY || type.kind === AstKind.INLINE_STRUCT || type.kind === AstKind.TEMPLATE_INSTANCE) return true;
    if (type.kind === AstKind.NAME) {
        const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
        if (baseName === "id" || baseName === "m256i" || baseName === "__m256i" || baseName === "uint128" || baseName === "uint128_t") return true;
        if (SCALAR_SIZE[type.name] !== undefined || SCALAR_SIZE[baseName] !== undefined) return false;
        return programAnalysis.layoutOfType(type) !== null;
    }
    return false;
}

export function typeKeyOf(programAnalysis: ProgramAnalysis, type: TypeSpec): string {
    return programAnalysis.typeKey(type);
}
