import { AstKind, BareNamePolicy, UnsupportedFeature } from "../shared/enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, NamespaceLookupContext } from "./types";
import type {
    TypeSpec,
    Expression,
    ClassTemplateDecl,
    Declaration,
    ExternBlockDecl,
    NamespaceDecl,
    StructDecl,
    FunctionDecl,
    FunctionTemplateDecl,
    TypedefDeclNode,
    VariableDecl,
} from "../ast";
import type { ProgramAnalysis } from "./program-analysis";
import { raiseUnsupported } from "./unsupported";

/** Index a declaration under both its addressable name and its bare name: without the qualified key two scopes collapse, without the bare one a using fails. */
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

    if (barePolicy === BareNamePolicy.SKIP) {
        return;
    }

    if (barePolicy === BareNamePolicy.OVERWRITE || !map.has(name)) {
        map.set(name, value);
    }
}

/**
 * Whether a declaration at `scopePrefix` owns the bare spelling of `name`. Nearest scope wins; equal
 * scope keeps last-writer-wins. Precedence is by scope, never by kind of declaration.
 */
export function claimsBareName(programAnalysis: ProgramAnalysis, name: string, scopePrefix: string): boolean {
    const owner = programAnalysis.bareNameScope.get(name);
    if (owner === undefined || owner === scopePrefix) return true;
    return scopeDepth(scopePrefix) < scopeDepth(owner);
}

/** How many namespace hops a scope prefix is from file scope. `""` is 0, `"Port::"` is 1. */
function scopeDepth(scopePrefix: string): number {
    return scopePrefix ? scopePrefix.split("::").length - 1 : 0;
}

/** Record the winner and return the policy its tables should register the bare key under. */
function bareNamePolicyFor(programAnalysis: ProgramAnalysis, name: string, scopePrefix: string, requested: BareNamePolicy): BareNamePolicy {
    if (!claimsBareName(programAnalysis, name, scopePrefix)) return BareNamePolicy.SKIP;
    programAnalysis.bareNameScope.set(name, scopePrefix);
    return requested;
}

/** The keys a scoped name may be indexed under, most specific first: as written, the scopes it can be reached from, then the bare tail a using gave it. */
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

/** C++ unqualified lookup order: innermost scope first, then each enclosing one, then visible using-directives, then the global. Qualified names differ. */
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

    // The bare name carries both globals and the contract's own members, and either hides a using-directive's name — so directives are the last resort.
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
                // Its bases are written unqualified, so remember where to resolve them from.
                if (nsPrefix) programAnalysis.structScope.set(structDeclaration, nsPrefix);
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
                    // Also under the declaration itself — see captureStructMethods for why the name-keyed table cannot tell two classes spelled alike apart.
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
                // The bare name is shared, so the fullest body wins it: a forward declaration must not displace the definition that follows it.
                const existing = programAnalysis.templates.get(ct.name);
                if (!existing || (ct.members?.length ?? 0) >= existing.members.length) {
                    programAnalysis.templates.set(ct.name, templateDeclaration);
                }
            }
            // Capture inline methods, including templates, so call-site types can complete their bindings lazily.
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
        // One ownership decision for the whole declaration, not one per table, or the first table's claim
        // silently settles it for the rest. User constants shadow seeded qpi.h constants of the same name.
        const effectivePolicy = bareNamePolicyFor(programAnalysis, variableDeclaration.name, scopePrefix, barePolicy);
        registerScoped(programAnalysis.constexprInit, scopePrefix, variableDeclaration.name, variableDeclaration.initializer, effectivePolicy);
        registerScoped(programAnalysis.constexprType, scopePrefix, variableDeclaration.name, variableDeclaration.type, effectivePolicy);
        // The initializer names its neighbours unqualified, so it has to be evaluated where it was written.
        registerScoped(programAnalysis.constexprScope, scopePrefix, variableDeclaration.name, scopePrefix, effectivePolicy);
        // Clearing the other kind follows ownership too: a namespaced constant must not delete the bare
        // enum constant a nearer declaration owns.
        for (const key of ownedKeys(scopePrefix, variableDeclaration.name, effectivePolicy)) {
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

/** The subset of those keys this declaration may clear: the bare one only when it owns it. */
function ownedKeys(scopePrefix: string, name: string, barePolicy: BareNamePolicy): string[] {
    const keys = scopedKeys(scopePrefix, name);
    return barePolicy === BareNamePolicy.SKIP ? keys.filter((key) => key !== name) : keys;
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
        // An aliased underlying type is stored resolved, so consumers see the real scalar, and the alias is read from the scope the enum was written in.
        const declaredName = resolvedKeyInScope(programAnalysis, type.underlyingType.name, scopePrefix, NO_SHADOWED_NAMES) ?? type.underlyingType.name;
        const scalarName = resolvedScalarName(programAnalysis, declaredName);
        const underlyingType = scalarName === declaredName ? type.underlyingType : { ...type.underlyingType, name: scalarName };
        const byteSize = SCALAR_SIZE[scalarName];
        if (byteSize !== undefined) registerScoped(programAnalysis.enumSize, scopePrefix, type.name, byteSize, barePolicy);
        registerScoped(programAnalysis.enumUnderlying, scopePrefix, type.name, underlyingType, barePolicy);
    }
    const enumType: TypeSpec = type.underlyingType ?? { kind: AstKind.NAME, name: "sint32" };
    let next = 0n;
    for (const member of type.members) {
        const numericValue = member.value ? programAnalysis.evalConstBig(member.value, EMPTY_TEMPLATE_BINDINGS) : next;
        next = numericValue + 1n;
        // A named enum owns its members (Code::X); an unnamed one's belong to the scope around it (Ch::K). Both stay reachable bare for using-directives.
        // `scopePrefix` is in the list because an unscoped enum's members also belong to the scope the
        // enum was declared in, which is the spelling a qualified read requires.
        const claimsBare = bareNamePolicyFor(programAnalysis, member.name, scopePrefix, barePolicy) !== BareNamePolicy.SKIP;
        const memberScopes = type.name
            ? [...new Set([...scopedKeys(scopePrefix, `${type.name}::`), scopePrefix, ""])]
            : [...new Set([scopePrefix, ""])];
        for (const scope of memberScopes) {
            const key = `${scope}${member.name}`;
            // `scope === ""` is the bare key only when the enum is not itself at file scope; when it is,
            // scopePrefix is "" and that key is the member's own declaration.
            if (key === member.name && scopePrefix !== "" && !claimsBare) continue;
            programAnalysis.constexprInit.delete(key);
            programAnalysis.constexprType.delete(key);
            programAnalysis.enumConst.set(key, programAnalysis.normalizeConst(numericValue, enumType));
            programAnalysis.enumConstType.set(key, enumType);
            programAnalysis.constCache.delete(key);
        }
    }
}

/** The type a typedef names, seen from the alias's own scope: `typedef Rec Alias` inside Beta means Beta's Rec, so every unqualified name is re-pointed. */
export function typedefTarget(programAnalysis: ProgramAnalysis, key: string): TypeSpec | undefined {
    const target = programAnalysis.typedefs.get(key);
    const scope = programAnalysis.typedefScope.get(key);
    return target && scope ? qualifyNamesInScope(programAnalysis, target, scope) : target;
}

const NO_SHADOWED_NAMES: ReadonlySet<string> = new Set();

// Does any declaration table hold this key? One combined test, since C++ looks up names and a template argument can name a type or a constant alike.
function declaresName(programAnalysis: ProgramAnalysis, key: string): boolean {
    return (
        programAnalysis.typedefs.has(key) ||
        programAnalysis.globalStructs.has(key) ||
        programAnalysis.enumSize.has(key) ||
        programAnalysis.enumNames.has(key) ||
        programAnalysis.templates.has(key) ||
        programAnalysis.constexprInit.has(key) ||
        programAnalysis.enumConst.has(key)
    );
}

/** The key a name written in this scope really means, or null to leave it alone: C++ looks outward, and a name an inner scope declares is never re-pointed. */
function resolvedKeyInScope(programAnalysis: ProgramAnalysis, name: string, scope: string, shadowed: ReadonlySet<string>): string | null {
    if (!scope || name.includes("::") || shadowed.has(name)) {
        return null;
    }

    const context: NamespaceLookupContext = { sourceNamespace: scope.endsWith("::") ? scope.slice(0, -2) : scope, usingNamespaces: [] };
    for (const key of unqualifiedLookupKeys(name, context)) {
        // The bare name comes after every enclosing scope, so reaching it means nothing closer declared one.
        if (key === name) return null;
        if (declaresName(programAnalysis, key)) return key;
    }
    return null;
}

/** Re-point every unqualified name a type carries at the scope it was written in — the type, an array's element and bound, a template's name and arguments. */
export function qualifyNamesInScope(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec,
    scope: string,
    shadowed: ReadonlySet<string> = NO_SHADOWED_NAMES,
): TypeSpec {
    if (!scope) {
        return type;
    }

    if (type.kind === AstKind.NAME) {
        const key = resolvedKeyInScope(programAnalysis, type.name, scope, shadowed);
        return key ? { ...type, name: key } : type;
    }

    if (type.kind === AstKind.ARRAY) {
        return {
            ...type,
            element: qualifyNamesInScope(programAnalysis, type.element, scope, shadowed),
            size: qualifyConstantIdentifiers(programAnalysis, type.size, scope, shadowed),
        };
    }

    if (type.kind === AstKind.CONST) {
        return { ...type, valueType: qualifyNamesInScope(programAnalysis, type.valueType, scope, shadowed) };
    }

    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
        const key = resolvedKeyInScope(programAnalysis, type.name, scope, shadowed);
        return {
            ...type,
            name: key ?? type.name,
            callArguments: type.callArguments.map((argument) => qualifyNamesInScope(programAnalysis, argument, scope, shadowed)),
        };
    }

    if (type.kind === AstKind.EXPR_VALUE) {
        return { ...type, expression: qualifyConstantIdentifiers(programAnalysis, type.expression, scope, shadowed) };
    }

    return type;
}

/** The same re-pointing for names a constant expression reads. Returns a new node rather than editing in place: `constexprInit` expressions are shared. */
function qualifyConstantIdentifiers(programAnalysis: ProgramAnalysis, expression: Expression, scope: string, shadowed: ReadonlySet<string>): Expression {
    if (expression.kind === AstKind.IDENTIFIER) {
        const key = resolvedKeyInScope(programAnalysis, expression.name, scope, shadowed);
        return key ? { ...expression, name: key } : expression;
    }

    if (expression.kind === AstKind.PAREN) {
        return { ...expression, expression: qualifyConstantIdentifiers(programAnalysis, expression.expression, scope, shadowed) };
    }

    if (expression.kind === AstKind.UNARY_OP) {
        return { ...expression, argument: qualifyConstantIdentifiers(programAnalysis, expression.argument, scope, shadowed) };
    }

    if (expression.kind === AstKind.BINARY_OP) {
        return {
            ...expression,
            left: qualifyConstantIdentifiers(programAnalysis, expression.left, scope, shadowed),
            right: qualifyConstantIdentifiers(programAnalysis, expression.right, scope, shadowed),
        };
    }

    if (expression.kind === AstKind.TERNARY) {
        return {
            ...expression,
            condition: qualifyConstantIdentifiers(programAnalysis, expression.condition, scope, shadowed),
            then: qualifyConstantIdentifiers(programAnalysis, expression.then, scope, shadowed),
            else_: qualifyConstantIdentifiers(programAnalysis, expression.else_, scope, shadowed),
        };
    }

    return expression;
}

/** Re-point the unqualified names a namespace's declarations write, over the contract's own TU only — the shared qpi.h AST keeps its bare spellings. */
export function qualifyDeclarationsInScope(
    programAnalysis: ProgramAnalysis,
    declarations: Declaration[],
    scope = "",
    shadowed: ReadonlySet<string> = NO_SHADOWED_NAMES,
): void {
    for (const declaration of declarations) {
        if (declaration.kind === AstKind.NAMESPACE) {
            const namespaceDeclaration = declaration as NamespaceDecl;
            qualifyDeclarationsInScope(programAnalysis, namespaceDeclaration.body, `${scope}${namespaceDeclaration.name}::`, shadowed);
        } else if (declaration.kind === AstKind.EXTERN_BLOCK) {
            qualifyDeclarationsInScope(programAnalysis, (declaration as ExternBlockDecl).body, scope, shadowed);
        } else if (scope && (declaration.kind === AstKind.STRUCT || declaration.kind === AstKind.CLASS_TEMPLATE)) {
            qualifyRecordInScope(programAnalysis, declaration as StructDecl | ClassTemplateDecl, scope, shadowed);
        }
    }
}

function qualifyRecordInScope(
    programAnalysis: ProgramAnalysis,
    record: StructDecl | ClassTemplateDecl,
    scope: string,
    outerShadowed: ReadonlySet<string>,
): void {
    const shadowed = shadowedNames(record, outerShadowed);
    record.bases = record.bases.map((base) => qualifyNamesInScope(programAnalysis, base, scope, shadowed));

    for (const member of record.members) {
        if (member.kind === AstKind.VARIABLE) {
            const variableDeclaration = member as VariableDecl;
            variableDeclaration.type = qualifyNamesInScope(programAnalysis, variableDeclaration.type, scope, shadowed);
            if (variableDeclaration.type.kind === AstKind.INLINE_STRUCT) {
                qualifyRecordInScope(programAnalysis, variableDeclaration.type.struct, scope, shadowed);
            }
        } else if (member.kind === AstKind.TYPEDEF_DECL) {
            const typedefDeclaration = member as TypedefDeclNode;
            typedefDeclaration.type = qualifyNamesInScope(programAnalysis, typedefDeclaration.type, scope, shadowed);
        } else if (member.kind === AstKind.STRUCT || member.kind === AstKind.CLASS_TEMPLATE) {
            qualifyRecordInScope(programAnalysis, member as StructDecl | ClassTemplateDecl, scope, shadowed);
        }
    }
}

/** The names that keep their meaning inside a record: what it declares and what it binds as a template parameter — matched by name, so never qualified. */
function shadowedNames(record: StructDecl | ClassTemplateDecl, outerShadowed: ReadonlySet<string>): ReadonlySet<string> {
    const shadowed = new Set(outerShadowed);
    if (record.kind === AstKind.CLASS_TEMPLATE) {
        for (const parameter of record.params) shadowed.add(parameter.name);
    }

    for (const member of record.members) {
        const declaresType =
            member.kind === AstKind.TYPEDEF_DECL || member.kind === AstKind.STRUCT || member.kind === AstKind.CLASS_TEMPLATE || member.kind === AstKind.ENUM;
        const name = declaresType ? (member as { name?: string }).name : undefined;
        if (name) shadowed.add(name);
    }
    return shadowed;
}

// The typedef a name reaches, followed from the scope that declared it.
export function followScopedTypedef(programAnalysis: ProgramAnalysis, name: string): TypeSpec | undefined {
    for (const key of scopedLookupKeys(name)) {
        if (!programAnalysis.typedefs.has(key)) {
            continue;
        }
        const target = programAnalysis.typedefTarget(key);
        // An alias is registered under its bare name too, so a qualified lookup can fall through and get
        // itself back; returning it spins alignOfNameType against alignOfTypeB forever.
        if (target?.kind === AstKind.NAME && target.name === name) {
            continue;
        }
        return target;
    }
    return undefined;
}

/** Does this name refer to a type at all? sizeOfType answers with a default for a name it cannot place, so telling a type from a local must ask here. */
export function namesAType(programAnalysis: ProgramAnalysis, name: string): boolean {
    return scopedLookupKeys(name).some(
        (key) =>
            SCALAR_SIZE[key] !== undefined ||
            programAnalysis.typedefs.has(key) ||
            programAnalysis.globalStructs.has(key) ||
            programAnalysis.nested.has(key) ||
            programAnalysis.enumNames.has(key) ||
            programAnalysis.templates.has(key),
    );
}

/** The scalar an alias chain ends at, followed from each link's own scope; returns the name unchanged when it never reaches one, so callers keep a fallback. */
export function resolvedScalarName(programAnalysis: ProgramAnalysis, name: string): string {
    let current = name;

    for (let depth = 0; depth < 8; depth++) {
        const scalarKey = scopedLookupKeys(current).find((key) => SCALAR_SIZE[key] !== undefined);
        if (scalarKey) {
            return scalarKey;
        }

        const target = followScopedTypedef(programAnalysis, current);
        if (!target || target.kind !== AstKind.NAME || target.name === current) {
            return current;
        }
        current = target.name;
    }
    return current;
}
