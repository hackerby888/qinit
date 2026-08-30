import { AstKind, BareNamePolicy, UnsupportedFeature } from "../shared/enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, NamespaceLookupContext } from "./types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";
import { raiseUnsupported } from "./unsupported";

/**
 * Index one declaration under both the name that addresses it from outside its scope and its bare name.
 * Without the qualified key two scopes sharing a name collapse into whichever registered last; without the
 * bare key a using-directive cannot reach it. `barePolicy` keeps each caller's existing precedence: a
 * namespace's later declaration wins, a name nested in a struct keeps the first one seen.
 */
export function registerScoped<Value>(
    map: Map<string, Value>,
    scopePrefix: string,
    name: string,
    value: Value,
    barePolicy: BareNamePolicy = BareNamePolicy.OVERWRITE,
): void {
    if (scopePrefix) {
        map.set(`${scopePrefix}${name}`, value);
    }

    if (barePolicy === BareNamePolicy.OVERWRITE || !map.has(name)) {
        map.set(name, value);
    }
}

/**
 * The keys a scoped name may be indexed under, most specific first: the name as written, the scopes it can be
 * reached from, then the bare tail a using-directive registered it under. One order for every scoped table, so
 * tightening it later is one edit rather than fifteen.
 */
export function scopedLookupKeys(name: string, context: NamespaceLookupContext = { usingNamespaces: [] }): string[] {
    const keys: string[] = [];
    const add = (key: string) => {
        if (!keys.includes(key)) keys.push(key);
    };

    add(name);
    if (context.sourceNamespace) {
        add(`${context.sourceNamespace}::${name}`);
    }
    for (const usingNamespace of context.usingNamespaces) {
        add(`${usingNamespace}::${name}`);
    }

    const separator = name.lastIndexOf("::");
    if (separator >= 0) {
        add(name.slice(separator + 2));
    }
    return keys;
}

export function lookupScoped<Value>(map: ReadonlyMap<string, Value>, name: string, context?: NamespaceLookupContext): Value | undefined {
    for (const key of scopedLookupKeys(name, context)) {
        const hit = map.get(key);
        if (hit !== undefined) return hit;
    }
    return undefined;
}

/**
 * C++ unqualified lookup order for a name written inside a scope: the innermost enclosing scope first, then
 * each enclosing one outward, then the visible using-directives, and only then the global name. A name that
 * already carries a qualifier is looked up as written instead, which `scopedLookupKeys` handles.
 */
export function unqualifiedLookupKeys(name: string, context: NamespaceLookupContext = { usingNamespaces: [] }): string[] {
    if (name.includes("::")) {
        return scopedLookupKeys(name, context);
    }

    const keys: string[] = [];
    const add = (key: string) => {
        if (!keys.includes(key)) keys.push(key);
    };

    // `A::B` encloses `A`, so walk the qualifier off one segment at a time.
    let scope = context.sourceNamespace;
    while (scope) {
        add(`${scope}::${name}`);
        const separator = scope.lastIndexOf("::");
        scope = separator > 0 ? scope.slice(0, separator) : undefined;
    }

    // The bare name carries both globals and the contract's own members, and either hides a name that a
    // using-directive merely made visible — so the directives are the last resort, not the first.
    add(name);
    for (const usingNamespace of context.usingNamespaces) {
        add(`${usingNamespace}::${name}`);
    }
    return keys;
}

export function registerTopLevelDeclarations(
    programAnalysis: ProgramAnalysis,
    declarations: Declaration[],
    nsPrefix = "",
    inheritedUsing: string[] = [],
): void {
    const scopeUsing = programAnalysis.namespaceUsings.get(nsPrefix) ?? [];
    if (!programAnalysis.namespaceUsings.has(nsPrefix)) programAnalysis.namespaceUsings.set(nsPrefix, scopeUsing);
    const activeUsing = [...new Set([...inheritedUsing, ...scopeUsing])];
    const sourceNamespace = nsPrefix.endsWith("::") ? nsPrefix.slice(0, -2) : nsPrefix || undefined;
    // A name in a namespace does not hide an outer one, so only a global declaration claims the bare key.
    const barePolicy = nsPrefix ? BareNamePolicy.KEEP : BareNamePolicy.OVERWRITE;
    for (const declaration of declarations) {
        const td = declaration.kind === AstKind.TYPEDEF_DECL ? (declaration as any) : null;
        const usingMatch = typeof td?.name === "string" ? /^using namespace (.+)$/.exec(td.name) : null;
        if (usingMatch) {
            if (!scopeUsing.includes(usingMatch[1])) scopeUsing.push(usingMatch[1]);
            if (!activeUsing.includes(usingMatch[1])) activeUsing.push(usingMatch[1]);
            continue;
        }
        const lookupContext: NamespaceLookupContext = {
            sourceNamespace,
            usingNamespaces: [...activeUsing],
        };
        programAnalysis.namespaceContexts.set(declaration, lookupContext);
        if (declaration.kind === AstKind.NAMESPACE) {
            programAnalysis.registerTopLevelDeclarations((declaration as any).body, `${nsPrefix}${(declaration as any).name}::`, activeUsing);
        } else if (declaration.kind === AstKind.EXTERN_BLOCK) {
            programAnalysis.registerTopLevelDeclarations((declaration as any).body, nsPrefix, activeUsing);
        } else if (declaration.kind === AstKind.STRUCT) {
            const structDeclaration = declaration as StructDecl;
            programAnalysis.captureMemberNamespaceContexts(structDeclaration.members, lookupContext);
            if (structDeclaration.name && structDeclaration.hasBody !== false) {
                registerScoped(programAnalysis.globalStructs, nsPrefix, structDeclaration.name, structDeclaration, barePolicy);
                // Inline value/void methods of a plain (non-template) struct — e.g. ProposalDataYesNo::checkValidity
                for (const member of structDeclaration.members) {
                    if (member.kind !== AstKind.FUNCTION || !(member as FunctionDecl).body) continue;
                    const fn = member as FunctionDecl;
                    if (fn.name.startsWith("~")) {
                        // Same discard as struct-index: a destructor body never runs, so say so.
                        if (fn.body?.kind === AstKind.COMPOUND && fn.body.body.length > 0) {
                            raiseUnsupported(programAnalysis, UnsupportedFeature.DESTRUCTOR, fn.span, fn.name);
                        }
                        continue;
                    }
                    if (!programAnalysis.templateMethods.has(structDeclaration.name)) programAnalysis.templateMethods.set(structDeclaration.name, new Map());
                    const into = programAnalysis.templateMethods.get(structDeclaration.name)!;
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
                    programAnalysis.namespaceContexts.set(def, lookupContext);
                    // overloads (isValid() vs static isValid(y,m,d,...)) are additionally keyed by arity so an arity-aware lookup picks the right one;
                    const akey = `${fn.name}/${(fn.params ?? []).length}`;
                    if (fn.params[0]) into.set(`${akey}@${programAnalysis.typeKey(programAnalysis.derefType(fn.params[0].type))}`, def);
                    if (!into.has(akey)) into.set(akey, def);
                    const firstDefault = fn.params.findIndex((param) => param.defaultValue !== undefined);
                    if (firstDefault >= 0) {
                        for (let arity = firstDefault; arity < fn.params.length; arity++) {
                            const defaultKey = `${fn.name}/${arity}`;
                            if (!into.has(defaultKey)) into.set(defaultKey, def);
                        }
                    }
                    if (!into.has(fn.name)) into.set(fn.name, def);
                    // Also under the declaration itself — see captureStructMethods for why the
                    // name-keyed table alone cannot tell two classes spelled the same apart.
                    if (!programAnalysis.methodsByDeclaration.has(structDeclaration)) programAnalysis.methodsByDeclaration.set(structDeclaration, new Map());
                    const owned = programAnalysis.methodsByDeclaration.get(structDeclaration)!;
                    if (fn.params[0]) owned.set(`${akey}@${programAnalysis.typeKey(programAnalysis.derefType(fn.params[0].type))}`, def);
                    if (!owned.has(akey)) owned.set(akey, def);
                    if (!owned.has(fn.name)) owned.set(fn.name, def);
                }
            }
            // file-scope structs can still nest constants/enums (e.g. a contract's static constexpr)
            programAnalysis.collectConstants(structDeclaration.members);
        } else if (declaration.kind === AstKind.CLASS_TEMPLATE) {
            const ct = declaration as any;
            programAnalysis.captureMemberNamespaceContexts(ct.members, lookupContext);
            if (ct.hasBody === false) continue;
            // Keep the primary template and index each partial specialization separately.
            const templateDeclaration = {
                params: ct.params,
                members: ct.members,
                bases: ct.bases,
            };
            if (ct.specializationArgs) {
                const specialization = {
                    specArgs: ct.specializationArgs,
                    templateDeclaration,
                };
                for (const key of nsPrefix ? [`${nsPrefix}${ct.name}`, ct.name] : [ct.name]) {
                    if (!programAnalysis.specializations.has(key)) programAnalysis.specializations.set(key, []);
                    programAnalysis.specializations.get(key)!.push(specialization);
                }
            } else {
                if (nsPrefix) {
                    programAnalysis.templates.set(`${nsPrefix}${ct.name}`, templateDeclaration);
                }
                // The bare name is shared, so the fullest body wins it — a forward declaration must not
                // displace the definition that follows it.
                const existing = programAnalysis.templates.get(ct.name);
                if (!existing || (ct.members?.length ?? 0) >= existing.members.length) {
                    programAnalysis.templates.set(ct.name, templateDeclaration);
                }
            }
            // Capture inline methods, including templates, so call-site types can complete their
            // bindings lazily.
            for (const classMember of ct.specializationArgs ? [] : ct.members) {
                if (
                    (classMember.kind !== AstKind.FUNCTION && classMember.kind !== AstKind.FUNCTION_TEMPLATE) ||
                    !(classMember as FunctionDecl | FunctionTemplateDecl).body
                )
                    continue;
                const memberDeclaration = classMember as FunctionDecl | FunctionTemplateDecl;
                if (!programAnalysis.templateMethods.has(ct.name)) programAnalysis.templateMethods.set(ct.name, new Map());
                const into = programAnalysis.templateMethods.get(ct.name)!;
                const def: FunctionTemplateDecl =
                    classMember.kind === AstKind.FUNCTION_TEMPLATE
                        ? (classMember as FunctionTemplateDecl)
                        : {
                              kind: AstKind.FUNCTION_TEMPLATE,
                              name: memberDeclaration.name,
                              params: ct.params,
                              functionParameters: (memberDeclaration as FunctionDecl).params,
                              returnType: memberDeclaration.returnType,
                              body: (memberDeclaration as FunctionDecl).body,
                              isConstexpr: memberDeclaration.isConstexpr,
                              span: memberDeclaration.span,
                          };
                programAnalysis.namespaceContexts.set(def, lookupContext);
                const functionParameters =
                    classMember.kind === AstKind.FUNCTION_TEMPLATE
                        ? ((classMember as FunctionTemplateDecl).functionParameters ?? [])
                        : (classMember as FunctionDecl).params;
                const functionName = memberDeclaration.name;
                const akey = `${functionName}/${functionParameters.length}`;
                if (functionParameters[0]) into.set(`${akey}@${programAnalysis.typeKey(programAnalysis.derefType(functionParameters[0].type))}`, def);
                if (!into.has(akey)) into.set(akey, def);
                if (!into.has(functionName)) into.set(functionName, def);
            }
        } else if (declaration.kind === AstKind.FUNCTION_TEMPLATE || declaration.kind === AstKind.FUNCTION) {
            // out-of-class template method definition: HashMap::set, Collection::add, ...
            const fn = declaration as FunctionTemplateDecl;
            const sep = fn.name.lastIndexOf("::");
            // Single-level NS::fn free function (not Class::method): owner is neither a known template nor struct.
            const owner = sep > 0 ? fn.name.slice(0, sep) : "";
            const ownerBase = owner.includes("::") ? owner.slice(owner.lastIndexOf("::") + 2) : owner;
            const freeQualified =
                sep > 0 &&
                fn.body &&
                declaration.kind === AstKind.FUNCTION &&
                !owner.includes("::") &&
                !programAnalysis.templates.has(ownerBase) &&
                !programAnalysis.globalStructs.has(ownerBase);
            if (freeQualified) {
                const key = fn.name;
                const overloads = programAnalysis.libFnOverloads.get(key);
                if (overloads) overloads.push(declaration as FunctionDecl);
                else programAnalysis.libFnOverloads.set(key, [declaration as FunctionDecl]);
                if (!programAnalysis.libFns.has(key)) programAnalysis.libFns.set(key, declaration as FunctionDecl);
            } else if (sep > 0 && fn.body) {
                const cls = ownerBase;
                const method = fn.name.slice(sep + 2);
                const methodDefinition: FunctionTemplateDecl =
                    declaration.kind === AstKind.FUNCTION_TEMPLATE
                        ? fn
                        : {
                              kind: AstKind.FUNCTION_TEMPLATE,
                              name: method,
                              params: [],
                              functionParameters: (declaration as FunctionDecl).params,
                              returnType: fn.returnType,
                              body: fn.body,
                              isConstexpr: fn.isConstexpr,
                              span: fn.span,
                          };
                programAnalysis.namespaceContexts.set(methodDefinition, lookupContext);
                if (!programAnalysis.templateMethods.has(cls)) programAnalysis.templateMethods.set(cls, new Map());
                // first definition wins (skip explicit specializations like HashFunction<m256i>)
                const minto = programAnalysis.templateMethods.get(cls)!;
                const makey = `${method}/${(fn.functionParameters ?? (fn as any).params ?? []).length}`;
                // Key explicit specializations by their concrete first parameter.
                if (methodDefinition.params.length === 0 && methodDefinition.functionParameters?.length) {
                    const concrete = programAnalysis.derefType(methodDefinition.functionParameters[0].type);
                    minto.set(`${makey}@${programAnalysis.typeKey(concrete)}`, methodDefinition);
                }
                if (!minto.has(makey)) minto.set(makey, methodDefinition);
                if (!minto.has(method)) minto.set(method, methodDefinition);
            } else if (sep < 0 && declaration.kind === AstKind.FUNCTION && (declaration as FunctionDecl).body) {
                // Index namespace and platform helpers by qualified name for lazy compilation.
                const key = `${nsPrefix}${fn.name}`;
                const overloads = programAnalysis.libFnOverloads.get(key);
                if (overloads) overloads.push(declaration as FunctionDecl);
                else programAnalysis.libFnOverloads.set(key, [declaration as FunctionDecl]);
                if (!programAnalysis.libFns.has(key)) programAnalysis.libFns.set(key, declaration as FunctionDecl);
            } else if (sep < 0 && declaration.kind === AstKind.FUNCTION_TEMPLATE && fn.body) {
                // Index namespace function templates by qualified name for call-site instantiation.
                const key = `${nsPrefix}${fn.name}`;
                const list = programAnalysis.libFnTemplates.get(key);
                if (list) list.push(fn as FunctionTemplateDecl);
                else programAnalysis.libFnTemplates.set(key, [fn as FunctionTemplateDecl]);
            }
        } else if (declaration.kind === AstKind.TYPEDEF_DECL) {
            registerScoped(programAnalysis.typedefs, nsPrefix, td.name, td.type, barePolicy);
            registerScoped(programAnalysis.typedefScope, nsPrefix, td.name, nsPrefix, barePolicy);
        } else if (declaration.kind === AstKind.VARIABLE) {
            programAnalysis.collectConstant(declaration as VariableDecl, nsPrefix, barePolicy);
        } else if (declaration.kind === AstKind.ENUM) {
            programAnalysis.collectEnum(declaration as any, nsPrefix, barePolicy);
        }
    }
}

export function captureMemberNamespaceContexts(programAnalysis: ProgramAnalysis, members: Declaration[], namespaceContext: NamespaceLookupContext): void {
    for (const member of members) {
        programAnalysis.namespaceContexts.set(member, namespaceContext);
        if (member.kind === AstKind.STRUCT || member.kind === AstKind.CLASS_TEMPLATE) {
            programAnalysis.captureMemberNamespaceContexts((member as StructDecl).members, namespaceContext);
        }
    }
}

export function namespaceContextOf(programAnalysis: ProgramAnalysis, declaration?: object | null): NamespaceLookupContext {
    return declaration ? (programAnalysis.namespaceContexts.get(declaration) ?? { usingNamespaces: [] }) : { usingNamespaces: [] };
}

export function namespaceCandidates(name: string, sourceNamespace?: string, usingNamespaces: string[] = []): string[] {
    const hasNamespace = name.includes("::");
    const keys: string[] = [];
    const add = (key: string) => {
        if (!keys.includes(key)) keys.push(key);
    };
    add(name);
    if (sourceNamespace) add(`${sourceNamespace}::${name}`);
    for (const ns of usingNamespaces) add(`${ns}::${name}`);
    if (!hasNamespace) add(name);
    return keys;
}

export function collectConstants(programAnalysis: ProgramAnalysis, members: Declaration[]): void {
    for (const member of members) {
        if (member.kind === AstKind.VARIABLE) programAnalysis.collectConstant(member as VariableDecl);
        else if (member.kind === AstKind.ENUM) programAnalysis.collectEnum(member as any);
    }
}

export function registerLibFnTemplate(programAnalysis: ProgramAnalysis, key: string, fn: FunctionTemplateDecl): void {
    if (!fn.body) return;
    const list = programAnalysis.libFnTemplates.get(key);
    if (list) list.push(fn);
    else programAnalysis.libFnTemplates.set(key, [fn]);
}

export function collectConstant(
    programAnalysis: ProgramAnalysis,
    variableDeclaration: VariableDecl,
    scopePrefix = "",
    barePolicy: BareNamePolicy = BareNamePolicy.OVERWRITE,
): void {
    if (variableDeclaration.initializer && (variableDeclaration.isConstexpr || variableDeclaration.type.kind === AstKind.CONST)) {
        // User constants shadow seeded qpi.h constants with the same unqualified name.
        registerScoped(programAnalysis.constexprInit, scopePrefix, variableDeclaration.name, variableDeclaration.initializer, barePolicy);
        registerScoped(programAnalysis.constexprType, scopePrefix, variableDeclaration.name, variableDeclaration.type, barePolicy);
        // The initializer names its neighbours unqualified, so it has to be evaluated where it was written.
        registerScoped(programAnalysis.constexprScope, scopePrefix, variableDeclaration.name, scopePrefix, barePolicy);
        for (const key of scopedKeys(scopePrefix, variableDeclaration.name)) {
            programAnalysis.enumConst.delete(key);
            programAnalysis.enumConstType.delete(key);
            programAnalysis.constCache.delete(key);
        }
    }
}

// The keys one scoped name occupies, qualified first — for the deletes that have to clear every one of them.
function scopedKeys(scopePrefix: string, name: string): string[] {
    return scopePrefix ? [`${scopePrefix}${name}`, name] : [name];
}

export function collectEnum(
    programAnalysis: ProgramAnalysis,
    type: {
        name?: string;
        underlyingType?: TypeSpec;
        members: {
            name: string;
            value?: Expression;
        }[];
    },
    scopePrefix = "",
    barePolicy: BareNamePolicy = BareNamePolicy.OVERWRITE,
): void {
    if (type.name) {
        for (const key of scopedKeys(scopePrefix, type.name)) {
            programAnalysis.enumNames.add(key);
        }
    }
    if (type.name && type.underlyingType?.kind === AstKind.NAME) {
        const byteSize = SCALAR_SIZE[type.underlyingType.name];
        if (byteSize !== undefined) registerScoped(programAnalysis.enumSize, scopePrefix, type.name, byteSize, barePolicy);
        registerScoped(programAnalysis.enumUnderlying, scopePrefix, type.name, type.underlyingType, barePolicy);
    }
    const enumType: TypeSpec = type.underlyingType ?? { kind: AstKind.NAME, name: "sint32" };
    let next = 0n;
    for (const member of type.members) {
        const numericValue = member.value ? programAnalysis.evalConstBig(member.value, EMPTY_TEMPLATE_BINDINGS) : next;
        next = numericValue + 1n;
        // A named enum owns its members (Code::X); an unnamed one's belong to the scope around it (Ch::K).
        // Both stay reachable bare, which is how a using-directive sees them.
        const memberScopes = type.name ? [...scopedKeys(scopePrefix, `${type.name}::`), ""] : [...new Set([scopePrefix, ""])];
        for (const scope of memberScopes) {
            const key = `${scope}${member.name}`;
            programAnalysis.constexprInit.delete(key);
            programAnalysis.constexprType.delete(key);
            programAnalysis.enumConst.set(key, programAnalysis.normalizeConst(numericValue, enumType));
            programAnalysis.enumConstType.set(key, enumType);
            programAnalysis.constCache.delete(key);
        }
    }
}

/**
 * The type a typedef names, seen from the scope the alias was declared in. `namespace Beta { typedef W Own; }`
 * means Beta's W, so an unqualified target is re-pointed at its own scope when that scope declares one.
 */
export function typedefTarget(programAnalysis: ProgramAnalysis, key: string): TypeSpec | undefined {
    const target = programAnalysis.typedefs.get(key);
    if (!target || target.kind !== AstKind.NAME || target.name.includes("::")) {
        return target;
    }

    const scope = programAnalysis.typedefScope.get(key);
    if (!scope) {
        return target;
    }

    const scoped = `${scope}${target.name}`;
    const declaredInScope = programAnalysis.typedefs.has(scoped) || programAnalysis.globalStructs.has(scoped) || programAnalysis.enumSize.has(scoped);
    return declaredInScope ? { ...target, name: scoped } : target;
}

// The typedef a name reaches, followed from the scope that declared it.
export function followScopedTypedef(programAnalysis: ProgramAnalysis, name: string): TypeSpec | undefined {
    for (const key of scopedLookupKeys(name)) {
        if (programAnalysis.typedefs.has(key)) {
            return programAnalysis.typedefTarget(key);
        }
    }
    return undefined;
}
