import { AstKind } from "../enums";
import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function collectNested(context: ProgramAnalysisInternals, contract: StructDecl): void {
    for (const member of contract.members) {
        if (member.kind === AstKind.STRUCT) {
            const structDeclaration = member as StructDecl;
            if (structDeclaration.hasBody === false)
                continue;
            context.nested.set(structDeclaration.name, structDeclaration);
            context.captureStructMethods(structDeclaration, [structDeclaration.name]);
            // Also register structs nested INSIDE this one under their qualified name (`Outer::Inner`), recursively.
            context.collectNestedStructs(structDeclaration, structDeclaration.name);
        }
        else if (member.kind === AstKind.VARIABLE) {
            context.collectConstant(member as VariableDecl);
        }
        else if (member.kind === AstKind.ENUM) {
            context.collectEnum(member as any);
        }
        else if (member.kind === AstKind.TYPEDEF_DECL) {
            // contract-member typedef (typedef Order _Order;) — register the alias so _Order-typed locals resolve their layout/fields.
            const td = member as any;
            if (!context.typedefs.has(td.name))
                context.typedefs.set(td.name, td.type);
        }
        else if (member.kind === AstKind.CLASS_TEMPLATE) {
            // Register nested templates and their inline methods like file-scope templates.
            const ct = member as any;
            if (ct.hasBody === false)
                continue;
            const prev = context.templates.get(ct.name);
            if (!prev || (prev.members?.length ?? 0) < (ct.members?.length ?? 0))
                context.templates.set(ct.name, ct);
            for (const mm of ct.specializationArgs ? [] : ct.members) {
                if (mm.kind !== AstKind.FUNCTION || !(mm as FunctionDecl).body)
                    continue;
                const fn = mm as FunctionDecl;
                if (!context.templateMethods.has(ct.name))
                    context.templateMethods.set(ct.name, new Map());
                const into = context.templateMethods.get(ct.name)!;
                const def: FunctionTemplateDecl = {
                    kind: AstKind.FUNCTION_TEMPLATE,
                    name: fn.name,
                    params: ct.params,
                    functionParameters: fn.params,
                    returnType: fn.returnType,
                    body: fn.body,
                    isConstexpr: fn.isConstexpr,
                    span: fn.span,
                };
                const akey = `${fn.name}/${(fn.params ?? []).length}`;
                if (!into.has(akey))
                    into.set(akey, def);
                if (!into.has(fn.name))
                    into.set(fn.name, def);
            }
        }
        else if (member.kind === AstKind.FUNCTION_TEMPLATE) {
            // Register contract-level function templates as source helpers.
            context.registerLibFnTemplate((member as FunctionTemplateDecl).name, member as FunctionTemplateDecl);
        }
    }
}

export function registerCalleeContractDeclarations(context: ProgramAnalysisInternals, name: string, declarations: Declaration[]): void {
    for (const declaration of declarations) {
        if (declaration.kind === AstKind.VARIABLE) {
            context.collectConstant(declaration as VariableDecl);
        }
        else if (declaration.kind === AstKind.ENUM) {
            context.collectEnum(declaration as any);
        }
        else if (declaration.kind === AstKind.STRUCT) {
            const structDeclaration = declaration as StructDecl;
            if (!structDeclaration.bases?.some((baseType) => baseType.kind === AstKind.NAME && baseType.name === "ContractBase"))
                continue;
            for (const member of structDeclaration.members) {
                if (member.kind === AstKind.STRUCT) {
                    const nested = member as StructDecl;
                    if (nested.hasBody === false)
                        continue;
                    context.globalStructs.set(`${name}::${nested.name}`, nested);
                    context.collectNestedStructs(nested, `${name}::${nested.name}`);
                }
                else if (member.kind === AstKind.TYPEDEF_DECL) {
                    const td = member as {
                        name: string;
                        type: TypeSpec;
                    };
                    context.typedefs.set(`${name}::${td.name}`, td.type);
                    if (!context.typedefs.has(td.name))
                        context.typedefs.set(td.name, td.type);
                }
                else if (member.kind === AstKind.FUNCTION) {
                    const fn = member as FunctionDecl;
                    if (!fn.body || !fn.isStatic)
                        continue;
                    const key = `${name}::${fn.name}`;
                    if (!context.libFns.has(key))
                        context.libFns.set(key, fn);
                }
                else if (member.kind === AstKind.FUNCTION_TEMPLATE) {
                    // Register callee templates for qualified calls despite their dropped static flag.
                    const fn = member as FunctionTemplateDecl;
                    context.registerLibFnTemplate(`${name}::${fn.name}`, fn);
                }
            }
        }
    }
}

export function captureStructMethods(context: ProgramAnalysisInternals, structDeclaration: StructDecl, names: string[]): void {
    for (const mm of structDeclaration.members) {
        if (mm.kind !== AstKind.FUNCTION || !(mm as FunctionDecl).body)
            continue;
        const fn = mm as FunctionDecl;
        if (fn.name.startsWith("~"))
            continue;
        const def: FunctionTemplateDecl = {
            kind: AstKind.FUNCTION_TEMPLATE,
            name: fn.name,
            params: [],
            functionParameters: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            isConstexpr: fn.isConstexpr,
            span: fn.span,
        };
        for (const cls of names) {
            if (!context.templateMethods.has(cls))
                context.templateMethods.set(cls, new Map());
            const into = context.templateMethods.get(cls)!;
            const akey = `${fn.name}/${(fn.params ?? []).length}`;
            if (!into.has(akey))
                into.set(akey, def);
            if (!into.has(fn.name))
                into.set(fn.name, def);
        }
    }
}

export function collectNestedStructs(context: ProgramAnalysisInternals, parent: StructDecl, prefix: string): void {
    for (const member of parent.members) {
        if (member.kind === AstKind.STRUCT) {
            const structDeclaration = member as StructDecl;
            if (structDeclaration.hasBody === false)
                continue;
            const key = `${prefix}::${structDeclaration.name}`;
            if (!context.nested.has(key))
                context.nested.set(key, structDeclaration);
            // Register nested structs unqualified for references within their owner.
            if (!context.nested.has(structDeclaration.name) && !context.globalStructs.has(structDeclaration.name))
                context.nested.set(structDeclaration.name, structDeclaration);
            context.captureStructMethods(structDeclaration, [structDeclaration.name, key]);
            context.collectNestedStructs(structDeclaration, key);
        }
    }
}

export function structByName(context: ProgramAnalysisInternals, name: string, templateBindings: TemplateBindings): StructDecl | undefined {
    const hit = templateBindings.structs.get(name) ?? context.nested.get(name) ?? context.globalStructs.get(name);
    if (hit)
        return hit;
    const index = name.lastIndexOf("::");
    if (index >= 0) {
        const unqualifiedName = name.slice(index + 2);
        return (templateBindings.structs.get(unqualifiedName) ??
            context.nested.get(unqualifiedName) ??
            context.globalStructs.get(unqualifiedName));
    }
    return undefined;
}

export function qualifiedNestedType(context: ProgramAnalysisInternals, name: string, templateBindings: TemplateBindings): TypeSpec | null {
    for (let sep = name.indexOf("::"); sep > 0; sep = name.indexOf("::", sep + 2)) {
        const head = name.slice(0, sep);
        const headType = templateBindings.types.get(head) ?? context.typedefs.get(head);
        const structDeclaration = headType
            ? context.structOf(headType, templateBindings)
            : context.structByName(head, templateBindings) ?? null;
        if (!structDeclaration)
            continue;
        const segments = name.slice(sep + 2).split("::");
        const walked = context.walkNestedSegments(structDeclaration, segments, templateBindings);
        if (walked)
            return walked;
    }
    return null;
}

export function walkNestedSegments(context: ProgramAnalysisInternals, sd: StructDecl | null, segs: string[], templateBindings: TemplateBindings): TypeSpec | null {
    for (let segmentIndex = 0; segmentIndex < segs.length; segmentIndex++) {
        if (!sd)
            return null;
        const seg = segs[segmentIndex];
        const last = segmentIndex === segs.length - 1;
        const ms = sd.members.find((member): member is StructDecl => (
            member.kind === AstKind.STRUCT &&
            member.name === seg &&
            member.hasBody !== false
        ));
        if (ms) {
            if (last)
                return { kind: AstKind.INLINE_STRUCT, struct: ms, span: ms.span };
            sd = ms;
            continue;
        }
        const mt = sd.members.find((member) => member.kind === AstKind.TYPEDEF_DECL && (member as any).name === seg) as any;
        if (!mt)
            return null;
        if (last)
            return mt.type;
        sd = context.structOf(mt.type, templateBindings);
    }
    return null;
}

export function structOf(context: ProgramAnalysisInternals, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructDecl | null {
    if (type.kind === AstKind.CONST)
        return context.structOf(type.valueType, templateBindings);
    if (type.kind === AstKind.REFERENCE)
        return context.structOf(type.referentType, templateBindings);
    if (type.kind === AstKind.INLINE_STRUCT)
        return type.struct;
    if (type.kind === AstKind.NAME) {
        const bound = templateBindings.types.get(type.name);
        if (bound)
            return context.structOf(bound, templateBindings);
        const td = context.typedefs.get(type.name);
        if (td)
            return context.structOf(td, templateBindings);
        const structDeclaration = context.structByName(type.name, templateBindings);
        if (structDeclaration)
            return structDeclaration;
        const qn = context.qualifiedNestedType(type.name, templateBindings);
        return qn ? context.structOf(qn, templateBindings) : null;
    }
    return null;
}
