import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, NamespaceLookupContext } from "./types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function registerTopLevelDeclarations(context: ProgramAnalysisInternals, declarations: Declaration[], nsPrefix = "", inheritedUsing: string[] = []): void {
    const scopeUsing = context.namespaceUsings.get(nsPrefix) ?? [];
    if (!context.namespaceUsings.has(nsPrefix))
        context.namespaceUsings.set(nsPrefix, scopeUsing);
    const activeUsing = [...new Set([...inheritedUsing, ...scopeUsing])];
    const sourceNamespace = nsPrefix.endsWith("::") ? nsPrefix.slice(0, -2) : nsPrefix || undefined;
    for (const declaration of declarations) {
        const td = declaration.kind === "typedef_decl" ? (declaration as any) : null;
        const usingMatch = typeof td?.name === "string" ? /^using namespace (.+)$/.exec(td.name) : null;
        if (usingMatch) {
            if (!scopeUsing.includes(usingMatch[1]))
                scopeUsing.push(usingMatch[1]);
            if (!activeUsing.includes(usingMatch[1]))
                activeUsing.push(usingMatch[1]);
            continue;
        }
        const lookupContext: NamespaceLookupContext = {
            sourceNamespace,
            usingNamespaces: [...activeUsing],
        };
        context.namespaceContexts.set(declaration, lookupContext);
        if (declaration.kind === "namespace") {
            context.registerTopLevelDeclarations((declaration as any).body, `${nsPrefix}${(declaration as any).name}::`, activeUsing);
        }
        else if (declaration.kind === "extern_block") {
            context.registerTopLevelDeclarations((declaration as any).body, nsPrefix, activeUsing);
        }
        else if (declaration.kind === "struct") {
            const structDeclaration = declaration as StructDecl;
            context.captureMemberNamespaceContexts(structDeclaration.members, lookupContext);
            if (structDeclaration.name) {
                context.globalStructs.set(structDeclaration.name, structDeclaration);
                // Inline value/void methods of a plain (non-template) struct — e.g. ProposalDataYesNo::checkValidity
                for (const member of structDeclaration.members) {
                    if (member.kind !== "function" || !(member as FunctionDecl).body)
                        continue;
                    const fn = member as FunctionDecl;
                    if (fn.name.startsWith("~"))
                        continue;
                    if (!context.templateMethods.has(structDeclaration.name))
                        context.templateMethods.set(structDeclaration.name, new Map());
                    const into = context.templateMethods.get(structDeclaration.name)!;
                    const def: FunctionTemplateDecl = {
                        kind: "function_template",
                        name: fn.name,
                        params: [],
                        functionParameters: fn.params,
                        returnType: fn.returnType,
                        body: fn.body,
                        isConstexpr: fn.isConstexpr,
                        span: fn.span,
                    };
                    context.namespaceContexts.set(def, lookupContext);
                    // overloads (isValid() vs static isValid(y,m,d,...)) are additionally keyed by arity so an arity-aware lookup picks the right one;
                    const akey = `${fn.name}/${(fn.params ?? []).length}`;
                    if (fn.params[0])
                        into.set(`${akey}@${context.typeKey(context.derefType(fn.params[0].type))}`, def);
                    if (!into.has(akey))
                        into.set(akey, def);
                    const firstDefault = fn.params.findIndex((param) => param.defaultValue !== undefined);
                    if (firstDefault >= 0) {
                        for (let arity = firstDefault; arity < fn.params.length; arity++) {
                            const defaultKey = `${fn.name}/${arity}`;
                            if (!into.has(defaultKey))
                                into.set(defaultKey, def);
                        }
                    }
                    if (!into.has(fn.name))
                        into.set(fn.name, def);
                }
            }
            // file-scope structs can still nest constants/enums (e.g. a contract's static constexpr)
            context.collectConstants(structDeclaration.members);
        }
        else if (declaration.kind === "class_template") {
            const ct = declaration as any;
            context.captureMemberNamespaceContexts(ct.members, lookupContext);
            // Keep the primary template and index each partial specialization separately.
            if (ct.specializationArgs) {
                if (!context.specializations.has(ct.name))
                    context.specializations.set(ct.name, []);
                context.specializations.get(ct.name)!.push({
                    specArgs: ct.specializationArgs,
                    templateDeclaration: { params: ct.params, members: ct.members, bases: ct.bases },
                });
            }
            else {
                const existing = context.templates.get(ct.name);
                if (!existing || (ct.members?.length ?? 0) >= existing.members.length) {
                    context.templates.set(ct.name, {
                        params: ct.params,
                        members: ct.members,
                        bases: ct.bases,
                    });
                }
            }
            // Capture inline methods, including templates, so call-site types can complete their
            // bindings lazily.
            for (const classMember of ct.specializationArgs ? [] : ct.members) {
                if ((classMember.kind !== "function" && classMember.kind !== "function_template") ||
                    !(classMember as FunctionDecl | FunctionTemplateDecl).body)
                    continue;
                const memberDeclaration = classMember as FunctionDecl | FunctionTemplateDecl;
                if (!context.templateMethods.has(ct.name))
                    context.templateMethods.set(ct.name, new Map());
                const into = context.templateMethods.get(ct.name)!;
                const def: FunctionTemplateDecl = classMember.kind === "function_template"
                    ? (classMember as FunctionTemplateDecl)
                    : {
                        kind: "function_template",
                        name: memberDeclaration.name,
                        params: ct.params,
                        functionParameters: (memberDeclaration as FunctionDecl).params,
                        returnType: memberDeclaration.returnType,
                        body: (memberDeclaration as FunctionDecl).body,
                        isConstexpr: memberDeclaration.isConstexpr,
                        span: memberDeclaration.span,
                    };
                context.namespaceContexts.set(def, lookupContext);
                const functionParameters = classMember.kind === "function_template"
                    ? ((classMember as FunctionTemplateDecl).functionParameters ?? [])
                    : (classMember as FunctionDecl).params;
                const functionName = memberDeclaration.name;
                const akey = `${functionName}/${functionParameters.length}`;
                if (functionParameters[0])
                    into.set(`${akey}@${context.typeKey(context.derefType(functionParameters[0].type))}`, def);
                if (!into.has(akey))
                    into.set(akey, def);
                if (!into.has(functionName))
                    into.set(functionName, def);
            }
        }
        else if (declaration.kind === "function_template" || declaration.kind === "function") {
            // out-of-class template method definition: HashMap::set, Collection::add, ...
            const fn = declaration as FunctionTemplateDecl;
            const sep = fn.name.lastIndexOf("::");
            // Single-level NS::fn free function (not Class::method): owner is neither a known template nor struct.
            const owner = sep > 0 ? fn.name.slice(0, sep) : "";
            const ownerBase = owner.includes("::") ? owner.slice(owner.lastIndexOf("::") + 2) : owner;
            const freeQualified = sep > 0 &&
                fn.body &&
                declaration.kind === "function" &&
                !owner.includes("::") &&
                !context.templates.has(ownerBase) &&
                !context.globalStructs.has(ownerBase);
            if (freeQualified) {
                const key = fn.name;
                const overloads = context.libFnOverloads.get(key);
                if (overloads)
                    overloads.push(declaration as FunctionDecl);
                else
                    context.libFnOverloads.set(key, [declaration as FunctionDecl]);
                if (!context.libFns.has(key))
                    context.libFns.set(key, declaration as FunctionDecl);
            }
            else if (sep > 0 && fn.body) {
                const cls = ownerBase;
                const method = fn.name.slice(sep + 2);
                const methodDefinition: FunctionTemplateDecl = declaration.kind === "function_template"
                    ? fn
                    : {
                        kind: "function_template",
                        name: method,
                        params: [],
                        functionParameters: (declaration as FunctionDecl).params,
                        returnType: fn.returnType,
                        body: fn.body,
                        isConstexpr: fn.isConstexpr,
                        span: fn.span,
                    };
                context.namespaceContexts.set(methodDefinition, lookupContext);
                if (!context.templateMethods.has(cls))
                    context.templateMethods.set(cls, new Map());
                // first definition wins (skip explicit specializations like HashFunction<m256i>)
                const minto = context.templateMethods.get(cls)!;
                const makey = `${method}/${(fn.functionParameters ?? (fn as any).params ?? []).length}`;
                // Key explicit specializations by their concrete first parameter.
                if (methodDefinition.params.length === 0 && methodDefinition.functionParameters?.length) {
                    const concrete = context.derefType(methodDefinition.functionParameters[0].type);
                    minto.set(`${makey}@${context.typeKey(concrete)}`, methodDefinition);
                }
                if (!minto.has(makey))
                    minto.set(makey, methodDefinition);
                if (!minto.has(method))
                    minto.set(method, methodDefinition);
            }
            else if (sep < 0 && declaration.kind === "function" && (declaration as FunctionDecl).body) {
                // Index namespace and platform helpers by qualified name for lazy compilation.
                const key = `${nsPrefix}${fn.name}`;
                const overloads = context.libFnOverloads.get(key);
                if (overloads)
                    overloads.push(declaration as FunctionDecl);
                else
                    context.libFnOverloads.set(key, [declaration as FunctionDecl]);
                if (!context.libFns.has(key))
                    context.libFns.set(key, declaration as FunctionDecl);
            }
            else if (sep < 0 && declaration.kind === "function_template" && fn.body) {
                // Index namespace function templates by qualified name for call-site instantiation.
                const key = `${nsPrefix}${fn.name}`;
                const list = context.libFnTemplates.get(key);
                if (list)
                    list.push(fn as FunctionTemplateDecl);
                else
                    context.libFnTemplates.set(key, [fn as FunctionTemplateDecl]);
            }
        }
        else if (declaration.kind === "typedef_decl") {
            context.typedefs.set(td.name, td.type);
        }
        else if (declaration.kind === "variable") {
            context.collectConstant(declaration as VariableDecl);
        }
        else if (declaration.kind === "enum") {
            context.collectEnum(declaration as any);
        }
    }
}

export function captureMemberNamespaceContexts(
    context: ProgramAnalysisInternals,
    members: Declaration[],
    namespaceContext: NamespaceLookupContext,
): void {
    for (const member of members) {
        context.namespaceContexts.set(member, namespaceContext);
        if (member.kind === "struct" || member.kind === "class_template") {
            context.captureMemberNamespaceContexts(
                (member as StructDecl).members,
                namespaceContext,
            );
        }
    }
}

export function namespaceContextOf(context: ProgramAnalysisInternals, declaration?: object | null): NamespaceLookupContext {
    return declaration
        ? (context.namespaceContexts.get(declaration) ?? { usingNamespaces: [] })
        : { usingNamespaces: [] };
}

export function namespaceCandidates(context: ProgramAnalysisInternals, name: string, sourceNamespace?: string, usingNamespaces: string[] = []): string[] {
    const hasNamespace = name.includes("::");
    const keys: string[] = [];
    const add = (key: string) => {
        if (!keys.includes(key))
            keys.push(key);
    };
    add(name);
    if (sourceNamespace)
        add(`${sourceNamespace}::${name}`);
    for (const ns of usingNamespaces)
        add(`${ns}::${name}`);
    if (!hasNamespace)
        add(name);
    return keys;
}

export function collectConstants(context: ProgramAnalysisInternals, members: Declaration[]): void {
    for (const member of members) {
        if (member.kind === "variable")
            context.collectConstant(member as VariableDecl);
        else if (member.kind === "enum")
            context.collectEnum(member as any);
    }
}

export function registerLibFnTemplate(context: ProgramAnalysisInternals, key: string, fn: FunctionTemplateDecl): void {
    if (!fn.body)
        return;
    const list = context.libFnTemplates.get(key);
    if (list)
        list.push(fn);
    else
        context.libFnTemplates.set(key, [fn]);
}

export function collectConstant(context: ProgramAnalysisInternals, variableDeclaration: VariableDecl): void {
    if (variableDeclaration.initializer && (variableDeclaration.isConstexpr || variableDeclaration.type.kind === "const")) {
        // User constants shadow seeded qpi.h constants with the same unqualified name.
        context.constexprInit.set(variableDeclaration.name, variableDeclaration.initializer);
        context.constexprType.set(variableDeclaration.name, variableDeclaration.type);
        context.enumConst.delete(variableDeclaration.name);
        context.enumConstType.delete(variableDeclaration.name);
        context.constCache.delete(variableDeclaration.name);
    }
}

export function collectEnum(context: ProgramAnalysisInternals, type: {
    name?: string;
    underlyingType?: TypeSpec;
    members: {
        name: string;
        value?: Expression;
    }[];
}): void {
    if (type.name) {
        context.enumNames.add(type.name);
    }
    if (type.name && type.underlyingType?.kind === "name") {
        const byteSize = SCALAR_SIZE[type.underlyingType.name];
        if (byteSize !== undefined)
            context.enumSize.set(type.name, byteSize);
        context.enumUnderlying.set(type.name, type.underlyingType);
    }
    const enumType: TypeSpec = type.underlyingType ?? { kind: "name", name: "sint32" };
    let next = 0n;
    for (const member of type.members) {
        const numericValue = member.value ? context.evalConstBig(member.value, EMPTY_TEMPLATE_BINDINGS) : next;
        next = numericValue + 1n;
        context.constexprInit.delete(member.name);
        context.constexprType.delete(member.name);
        context.enumConst.set(member.name, context.normalizeConst(numericValue, enumType));
        context.enumConstType.set(member.name, enumType);
        context.constCache.delete(member.name);
        if (type.name) {
            context.enumConst.set(`${type.name}::${member.name}`, context.normalizeConst(numericValue, enumType));
            context.enumConstType.set(`${type.name}::${member.name}`, enumType);
            context.constCache.delete(`${type.name}::${member.name}`);
        }
    }
}
