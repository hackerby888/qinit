import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, VariableDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function sizeOfType(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    // Guard against recursive/self-referential types (a struct reachable from its own field).
    if (context.sizeDepth > 80) {
        context.warn("type nesting too deep / recursive — sized as 0", 0);
        return 0;
    }
    context.sizeDepth++;
    try {
        return context.sizeOfTypeInner(type, templateBindings);
    }
    finally {
        context.sizeDepth--;
    }
}

export function sizeOfTypeInner(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings): number {
    if (type.kind === "const")
        return context.sizeOfType(type.valueType, templateBindings);
    if (type.kind === "reference" || type.kind === "pointer")
        return 4;
    if (type.kind === "void")
        return 0;
    if (type.kind === "array") {
        const constantValue = context.evalConst(type.size, templateBindings);
        return context.sizeOfType(type.element, templateBindings) * constantValue;
    }
    if (type.kind === "inline_struct") {
        return context.layoutOfStruct(type.struct, templateBindings).size;
    }
    if (type.kind === "name") {
        const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
        // template parameter bound to a concrete type?
        const bound = templateBindings.types.get(type.name) ?? templateBindings.types.get(baseName);
        if (bound)
            return context.sizeOfType(bound, templateBindings);
        const size = SCALAR_SIZE[type.name] ?? SCALAR_SIZE[baseName];
        if (size !== undefined)
            return size;
        const td = context.typedefs.get(type.name) ?? context.typedefs.get(baseName);
        if (td)
            return context.sizeOfType(td, templateBindings);
        const struct = context.structByName(type.name, templateBindings);
        if (struct)
            return context.layoutOfStruct(struct, templateBindings).size;
        const qn = context.qualifiedNestedType(type.name, templateBindings);
        if (qn)
            return context.sizeOfType(qn, templateBindings);
        // asset iterators occupy their 8-byte runtime shape (count @0, cursor @4) wherever they live
        if (/Asset(Ownership|Possession)Iterator$/.test(type.name))
            return 8;
        // an enum type: sized by its declared underlying type (enum class X : uint8 → 1), default int
        const es = context.enumSize.get(type.name) ?? context.enumSize.get(type.name.split("::").pop()!);
        if (es !== undefined)
            return es;
        const num = parseInt(type.name);
        if (!isNaN(num))
            return num; // shouldn't happen for a type, defensive
        return 4; // assume enum-sized
    }
    if (type.kind === "template_instance") {
        return context.layoutOfTemplate(type.name, type.callArguments, templateBindings).size;
    }
    if (type.kind === "dependent_member") {
        const resolvedMember = context.resolveDependentMember(type, templateBindings);
        if (resolvedMember)
            return context.sizeOfType(resolvedMember.type, resolvedMember.bindings);
        return 0;
    }
    return 0;
}

export function resolveDependentMember(context: ProgramAnalysisInternals, type: Extract<TypeSpec, {
    kind: "dependent_member";
}>, templateBindings: TemplateBindings): {
    type: TypeSpec;
    bindings: TemplateBindings;
} | null {
    const base = type.base;
    if (base.kind !== "template_instance")
        return null;
    const inst = context.instantiateTemplate(base.name, base.callArguments, templateBindings);
    if (!inst)
        return null;
    for (const member of inst.templateDeclaration.members) {
        if (member.kind === "typedef_decl" && (member as any).name === type.member) {
            return { type: (member as any).type, bindings: inst.b };
        }
    }
    return null;
}

export function resolveType(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings, depth = 0): TypeSpec {
    if (depth > 24 || type.kind !== "name")
        return type;
    const bound = templateBindings.types.get(type.name);
    if (bound && !(bound.kind === "name" && bound.name === type.name)) {
        return context.resolveType(bound, templateBindings, depth + 1);
    }
    const td = context.typedefs.get(type.name);
    if (td && !(td.kind === "name" && td.name === type.name)) {
        return context.resolveType(td, templateBindings, depth + 1);
    }
    const qn = context.qualifiedNestedType(type.name, templateBindings);
    if (qn)
        return qn;
    return type;
}

export function concreteMemberType(context: ProgramAnalysisInternals, type: TypeSpec, parent: TypeSpec & {
    kind: "template_instance";
}, depth = 0): TypeSpec {
    const inst = context.instantiateTemplate(parent.name, parent.callArguments, EMPTY_TEMPLATE_BINDINGS);
    if (!inst)
        return type;
    const nested = new Map<string, TypeSpec>();
    for (const member of inst.templateDeclaration.members) {
        if (member.kind === "typedef_decl")
            nested.set((member as any).name, (member as any).type);
    }
    return context.resolveInScope(type, inst.b, nested, depth);
}

export function resolveInScope(context: ProgramAnalysisInternals, type: TypeSpec, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
    if (depth > 24)
        return type;
    if (type.kind === "const") {
        return {
            kind: "const",
            valueType: context.resolveInScope(type.valueType, scope, nested, depth + 1),
        };
    }
    if (type.kind === "array") {
        return {
            kind: "array",
            element: context.resolveInScope(type.element, scope, nested, depth + 1),
            size: type.size,
        };
    }
    if (type.kind === "name") {
        return context.resolveNamedTypeInScope(type, scope, nested, depth);
    }
    if (type.kind === "template_instance") {
        const resolvedCallArguments = context.resolveTemplateInstanceArguments(type, scope, nested, depth);
        return { kind: "template_instance", name: type.name, callArguments: resolvedCallArguments };
    }
    return type;
}

export function resolveNamedTypeInScope(context: ProgramAnalysisInternals, type: Extract<TypeSpec, {
    kind: "name";
}>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
    const boundType = scope.types.get(type.name);
    if (boundType && !(boundType.kind === "name" && boundType.name === type.name))
        return context.resolveInScope(boundType, scope, nested, depth + 1);
    const nestedType = nested.get(type.name);
    if (nestedType && !(nestedType.kind === "name" && nestedType.name === type.name))
        return context.resolveInScope(nestedType, scope, nested, depth + 1);
    const typedefType = context.typedefs.get(type.name);
    if (typedefType && !(typedefType.kind === "name" && typedefType.name === type.name))
        return context.resolveInScope(typedefType, scope, nested, depth + 1);
    const qualifiedType = context.qualifiedNestedType(type.name, scope);
    if (qualifiedType)
        return qualifiedType;
    return type;
}

export function resolveTemplateInstanceArguments(context: ProgramAnalysisInternals, type: Extract<TypeSpec, {
    kind: "template_instance";
}>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec[] {
    return type.callArguments.map((argument) => {
        if (argument.kind === "name" && scope.values.has(argument.name)) {
            return {
                kind: "expr_value",
                expression: {
                    kind: "int_literal",
                    value: scope.values.get(argument.name)!.toString(),
                    span: { start: 0, end: 0, line: 0, column: 0 },
                },
            } as TypeSpec;
        }
        return context.resolveInScope(argument, scope, nested, depth + 1);
    });
}

export function substInBindings(context: ProgramAnalysisInternals, type: TypeSpec, bind: TemplateBindings): TypeSpec {
    return context.resolveInScope(type, bind, new Map(), 0);
}

export function valueOfTypeArg(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint {
    return context.evalConstFromType(type, templateBindings);
}

export function evalConstFromType(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings): bigint {
    // A non-type template arg arrives as a TypeSpec; recover its integer value.
    if (type.kind === "expr_value")
        return context.evalConstBig(type.expression, templateBindings);
    if (type.kind === "name") {
        const numericValue = templateBindings.values.get(type.name);
        if (numericValue !== undefined)
            return numericValue;
        const count = parseInt(type.name);
        if (!isNaN(count))
            return BigInt(count);
        // a named constant template arg (e.g. Array<RoundInfo, QEARN_MAX_EPOCHS>)
        const resolvedConstant = context.resolveConst(type.name, templateBindings);
        if (resolvedConstant !== null)
            return resolvedConstant;
    }
    return 0n;
}

export function typeKey(context: ProgramAnalysisInternals, type: TypeSpec): string {
    if (type.kind === "name")
        return type.name;
    if (type.kind === "template_instance")
        return `${type.name}<${type.callArguments.map((argument) => context.typeKey(argument)).join(",")}>`;
    if (type.kind === "const")
        return "c" + context.typeKey(type.valueType);
    if (type.kind === "array")
        return `${context.typeKey(type.element)}[]`;
    if (type.kind === "pointer")
        return "*";
    if (type.kind === "expr_value")
        return `#${context.evalConst(type.expression)}`;
    // inline-carried struct as a template arg (Array<Order,256> resolved through its declaring scope): key by tag + field names
    if (type.kind === "inline_struct") {
        const fields = type.struct.members
            .filter((member) => member.kind === "variable")
            .map((variableDeclaration) => (variableDeclaration as VariableDecl).name)
            .join(",");
        return `s:${type.struct.name || "anon"}{${fields}}`;
    }
    return "?";
}

export function derefType(context: ProgramAnalysisInternals, type: TypeSpec): TypeSpec {
    if (type.kind === "const")
        return context.derefType(type.valueType);
    if (type.kind === "reference")
        return context.derefType(type.referentType);
    return type;
}

export function isVoidType(context: ProgramAnalysisInternals, type: TypeSpec): boolean {
    const dereferencedType = context.derefType(type);
    return dereferencedType.kind === "void" || (dereferencedType.kind === "name" && dereferencedType.name === "void");
}

export function isAggregateType(context: ProgramAnalysisInternals, type: TypeSpec): boolean {
    if (type.kind === "const")
        return context.isAggregateType(type.valueType);
    if (type.kind === "reference")
        return context.isAggregateType(type.referentType);
    if (type.kind === "array" || type.kind === "inline_struct" || type.kind === "template_instance")
        return true;
    if (type.kind === "name") {
        const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
        if (baseName === "id" ||
            baseName === "m256i" ||
            baseName === "__m256i" ||
            baseName === "uint128" ||
            baseName === "uint128_t")
            return true;
        if (SCALAR_SIZE[type.name] !== undefined || SCALAR_SIZE[baseName] !== undefined)
            return false;
        return context.layoutOfType(type) !== null;
    }
    return false;
}

export function typeKeyOf(context: ProgramAnalysisInternals, type: TypeSpec): string {
    return context.typeKey(type);
}
