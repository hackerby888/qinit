import { AstKind, BareNamePolicy, UnsupportedFeature } from "../shared/enums";
import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";
import { raiseUnsupported } from "./unsupported";
import { registerScoped } from "./declaration-index";

export function collectNested(programAnalysis: ProgramAnalysis, contract: StructDecl): void {
    for (const member of contract.members) {
        if (member.kind === AstKind.STRUCT) {
            const structDeclaration = member as StructDecl;
            if (structDeclaration.hasBody === false) continue;
            programAnalysis.nested.set(structDeclaration.name, structDeclaration);
            programAnalysis.captureStructMethods(structDeclaration, [structDeclaration.name]);
            // Also register structs nested INSIDE this one under their qualified name (`Outer::Inner`), recursively.
            programAnalysis.collectNestedStructs(structDeclaration, structDeclaration.name);
        } else if (member.kind === AstKind.VARIABLE) {
            programAnalysis.collectConstant(member as VariableDecl);
        } else if (member.kind === AstKind.ENUM) {
            programAnalysis.collectEnum(member as any);
        } else if (member.kind === AstKind.TYPEDEF_DECL) {
            // contract-member typedef (typedef Order _Order;) — register the alias so _Order-typed locals resolve their layout/fields.
            const td = member as any;
            if (!programAnalysis.typedefs.has(td.name)) programAnalysis.typedefs.set(td.name, td.type);
        } else if (member.kind === AstKind.CLASS_TEMPLATE) {
            // Register nested templates and their inline methods like file-scope templates.
            const ct = member as any;
            if (ct.hasBody === false) continue;
            // A contract's own template shadows a core one of the same name whole, parameter list
            // included, so it is kept apart rather than compared by member count.
            programAnalysis.nestedTemplates.set(ct.name, ct);
            const prev = programAnalysis.templates.get(ct.name);
            if (!prev || (prev.members?.length ?? 0) < (ct.members?.length ?? 0)) programAnalysis.templates.set(ct.name, ct);
            for (const mm of ct.specializationArgs ? [] : ct.members) {
                if (mm.kind !== AstKind.FUNCTION || !(mm as FunctionDecl).body) continue;
                const fn = mm as FunctionDecl;
                if (!programAnalysis.templateMethods.has(ct.name)) programAnalysis.templateMethods.set(ct.name, new Map());
                const into = programAnalysis.templateMethods.get(ct.name)!;
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
                if (!into.has(akey)) into.set(akey, def);
                if (!into.has(fn.name)) into.set(fn.name, def);
            }
        } else if (member.kind === AstKind.FUNCTION_TEMPLATE) {
            // Register contract-level function templates as source helpers.
            programAnalysis.registerLibFnTemplate((member as FunctionTemplateDecl).name, member as FunctionTemplateDecl);
        }
    }
}

export function registerCalleeContractDeclarations(programAnalysis: ProgramAnalysis, name: string, declarations: Declaration[]): void {
    for (const declaration of declarations) {
        if (declaration.kind === AstKind.VARIABLE) {
            programAnalysis.collectConstant(declaration as VariableDecl);
        } else if (declaration.kind === AstKind.ENUM) {
            programAnalysis.collectEnum(declaration as any);
        } else if (declaration.kind === AstKind.STRUCT) {
            const structDeclaration = declaration as StructDecl;
            if (!structDeclaration.bases?.some((baseType) => baseType.kind === AstKind.NAME && baseType.name === "ContractBase")) continue;
            for (const member of structDeclaration.members) {
                if (member.kind === AstKind.STRUCT) {
                    const nested = member as StructDecl;
                    if (nested.hasBody === false) continue;
                    programAnalysis.globalStructs.set(`${name}::${nested.name}`, nested);
                    programAnalysis.collectNestedStructs(nested, `${name}::${nested.name}`);
                } else if (member.kind === AstKind.TYPEDEF_DECL) {
                    const td = member as {
                        name: string;
                        type: TypeSpec;
                    };
                    registerScoped(programAnalysis.typedefs, `${name}::`, td.name, td.type, BareNamePolicy.KEEP);
                } else if (member.kind === AstKind.FUNCTION) {
                    const fn = member as FunctionDecl;
                    if (!fn.body || !fn.isStatic) continue;
                    const key = `${name}::${fn.name}`;
                    if (!programAnalysis.libFns.has(key)) programAnalysis.libFns.set(key, fn);
                } else if (member.kind === AstKind.FUNCTION_TEMPLATE) {
                    // Register callee templates for qualified calls despite their dropped static flag.
                    const fn = member as FunctionTemplateDecl;
                    programAnalysis.registerLibFnTemplate(`${name}::${fn.name}`, fn);
                }
            }
        }
    }
}

export function captureStructMethods(programAnalysis: ProgramAnalysis, structDeclaration: StructDecl, names: string[]): void {
    for (const mm of structDeclaration.members) {
        // A member function template is a method like any other; its template parameters are its own
        // rather than the class's, which a plain struct does not have.
        const isMethodTemplate = mm.kind === AstKind.FUNCTION_TEMPLATE;
        if ((mm.kind !== AstKind.FUNCTION && !isMethodTemplate) || !(mm as FunctionDecl | FunctionTemplateDecl).body) continue;
        const fn = mm as FunctionDecl | FunctionTemplateDecl;
        if (fn.name.startsWith("~")) {
            // Destructors are never invoked -- no scope-exit lowering exists -- so a body with statements
            // is silently lost. An empty one is a genuine no-op and stays allowed.
            if (fn.body?.kind === AstKind.COMPOUND && fn.body.body.length > 0) {
                raiseUnsupported(programAnalysis, UnsupportedFeature.DESTRUCTOR, fn.span, fn.name);
            }
            continue;
        }
        const functionParameters = (isMethodTemplate ? (fn as FunctionTemplateDecl).functionParameters : (fn as FunctionDecl).params) ?? [];
        const def: FunctionTemplateDecl = {
            kind: AstKind.FUNCTION_TEMPLATE,
            name: fn.name,
            params: isMethodTemplate ? ((fn as FunctionTemplateDecl).params ?? []) : [],
            functionParameters,
            returnType: fn.returnType,
            body: fn.body,
            isConstexpr: fn.isConstexpr,
            span: fn.span,
        };
        const akey = `${fn.name}/${functionParameters.length}`;
        // Overloads of one arity are told apart by their first parameter's type, the same key
        // declaration-index writes for file-scope structs.
        const typedKey = functionParameters[0] ? `${akey}@${programAnalysis.typeKey(programAnalysis.derefType(functionParameters[0].type))}` : null;

        for (const cls of names) {
            if (!programAnalysis.templateMethods.has(cls)) programAnalysis.templateMethods.set(cls, new Map());
            const into = programAnalysis.templateMethods.get(cls)!;
            if (typedKey) into.set(typedKey, def);
            if (!into.has(akey)) into.set(akey, def);
            if (!into.has(fn.name)) into.set(fn.name, def);
        }

        // The same entries under the declaration itself: the name-keyed table is first-writer-wins,
        // so a class whose name a qpi type already claimed would otherwise never see its own bodies.
        if (!programAnalysis.methodsByDeclaration.has(structDeclaration)) programAnalysis.methodsByDeclaration.set(structDeclaration, new Map());
        const owned = programAnalysis.methodsByDeclaration.get(structDeclaration)!;
        if (typedKey) owned.set(typedKey, def);
        if (!owned.has(akey)) owned.set(akey, def);
        if (!owned.has(fn.name)) owned.set(fn.name, def);
    }
}

export function collectNestedStructs(programAnalysis: ProgramAnalysis, parent: StructDecl, prefix: string): void {
    for (const member of parent.members) {
        if (member.kind === AstKind.STRUCT) {
            const structDeclaration = member as StructDecl;
            if (structDeclaration.hasBody === false) continue;
            const key = `${prefix}::${structDeclaration.name}`;
            if (!programAnalysis.nested.has(key)) programAnalysis.nested.set(key, structDeclaration);
            // Register nested structs unqualified for references within their owner.
            if (!programAnalysis.nested.has(structDeclaration.name) && !programAnalysis.globalStructs.has(structDeclaration.name))
                programAnalysis.nested.set(structDeclaration.name, structDeclaration);
            programAnalysis.captureStructMethods(structDeclaration, [structDeclaration.name, key]);
            programAnalysis.collectNestedStructs(structDeclaration, key);
        }
    }
}

export function structByName(programAnalysis: ProgramAnalysis, name: string, templateBindings: TemplateBindings): StructDecl | undefined {
    const hit = templateBindings.structs.get(name) ?? programAnalysis.nested.get(name) ?? programAnalysis.globalStructs.get(name);
    if (hit) return hit;
    const index = name.lastIndexOf("::");
    if (index >= 0) {
        const unqualifiedName = name.slice(index + 2);
        return (
            templateBindings.structs.get(unqualifiedName) ?? programAnalysis.nested.get(unqualifiedName) ?? programAnalysis.globalStructs.get(unqualifiedName)
        );
    }
    return undefined;
}

export function qualifiedNestedType(programAnalysis: ProgramAnalysis, name: string, templateBindings: TemplateBindings): TypeSpec | null {
    for (let sep = name.indexOf("::"); sep > 0; sep = name.indexOf("::", sep + 2)) {
        const head = name.slice(0, sep);
        const headType = templateBindings.types.get(head) ?? programAnalysis.typedefs.get(head);
        const structDeclaration = headType
            ? programAnalysis.structOf(headType, templateBindings)
            : (programAnalysis.structByName(head, templateBindings) ?? null);
        if (!structDeclaration) continue;
        const segments = name.slice(sep + 2).split("::");
        const walked = programAnalysis.walkNestedSegments(structDeclaration, segments, templateBindings);
        if (walked) return walked;
    }
    return null;
}

export function walkNestedSegments(
    programAnalysis: ProgramAnalysis,
    sd: StructDecl | null,
    segs: string[],
    templateBindings: TemplateBindings,
): TypeSpec | null {
    for (let segmentIndex = 0; segmentIndex < segs.length; segmentIndex++) {
        if (!sd) return null;
        const seg = segs[segmentIndex];
        const last = segmentIndex === segs.length - 1;
        const ms = sd.members.find((member): member is StructDecl => member.kind === AstKind.STRUCT && member.name === seg && member.hasBody !== false);
        if (ms) {
            if (last) return { kind: AstKind.INLINE_STRUCT, struct: ms, span: ms.span };
            sd = ms;
            continue;
        }
        const mt = sd.members.find((member) => member.kind === AstKind.TYPEDEF_DECL && (member as any).name === seg) as any;
        if (!mt) return null;
        if (last) return mt.type;
        sd = programAnalysis.structOf(mt.type, templateBindings);
    }
    return null;
}

export function structOf(programAnalysis: ProgramAnalysis, type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructDecl | null {
    if (type.kind === AstKind.CONST) return programAnalysis.structOf(type.valueType, templateBindings);
    if (type.kind === AstKind.REFERENCE) return programAnalysis.structOf(type.referentType, templateBindings);
    if (type.kind === AstKind.INLINE_STRUCT) return type.struct;
    if (type.kind === AstKind.NAME) {
        const bound = templateBindings.types.get(type.name);
        if (bound) return programAnalysis.structOf(bound, templateBindings);
        const td = programAnalysis.typedefs.get(type.name);
        if (td) return programAnalysis.structOf(td, templateBindings);
        const structDeclaration = programAnalysis.structByName(type.name, templateBindings);
        if (structDeclaration) return structDeclaration;
        const qn = programAnalysis.qualifiedNestedType(type.name, templateBindings);
        return qn ? programAnalysis.structOf(qn, templateBindings) : null;
    }
    return null;
}
