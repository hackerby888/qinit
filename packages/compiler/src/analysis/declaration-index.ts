import { AstKind } from "../shared/enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, NamespaceLookupContext } from "./types";
import type {
    TypeSpec,
    Expression,
    Declaration,
    StructDecl,
    FunctionDecl,
    FunctionTemplateDecl,
    VariableDecl,
} from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function registerTopLevelDeclarations(
    programAnalysis: ProgramAnalysis,
    declarations: Declaration[],
    nsPrefix = "",
    inheritedUsing: string[] = [],
): void {
    const scopeUsing = programAnalysis.namespaceUsings.get(nsPrefix) ?? [];
    if (!programAnalysis.namespaceUsings.has(nsPrefix))
        programAnalysis.namespaceUsings.set(nsPrefix, scopeUsing);
    const activeUsing = [...new Set([...inheritedUsing, ...scopeUsing])];
    const sourceNamespace = nsPrefix.endsWith("::") ? nsPrefix.slice(0, -2) : nsPrefix || undefined;
    for (const declaration of declarations) {
        const td = declaration.kind === AstKind.TYPEDEF_DECL ? (declaration as any) : null;
        const usingMatch =
            typeof td?.name === "string" ? /^using namespace (.+)$/.exec(td.name) : null;
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
            programAnalysis.registerTopLevelDeclarations(
                (declaration as any).body,
                `${nsPrefix}${(declaration as any).name}::`,
                activeUsing,
            );
        } else if (declaration.kind === AstKind.EXTERN_BLOCK) {
            programAnalysis.registerTopLevelDeclarations(
                (declaration as any).body,
                nsPrefix,
                activeUsing,
            );
        } else if (declaration.kind === AstKind.STRUCT) {
            const structDeclaration = declaration as StructDecl;
            programAnalysis.captureMemberNamespaceContexts(
                structDeclaration.members,
                lookupContext,
            );
            if (structDeclaration.name && structDeclaration.hasBody !== false) {
                if (nsPrefix) {
                    programAnalysis.globalStructs.set(
                        `${nsPrefix}${structDeclaration.name}`,
                        structDeclaration,
                    );
                }
                programAnalysis.globalStructs.set(structDeclaration.name, structDeclaration);
                // Inline value/void methods of a plain (non-template) struct — e.g. ProposalDataYesNo::checkValidity
                for (const member of structDeclaration.members) {
                    if (member.kind !== AstKind.FUNCTION || !(member as FunctionDecl).body)
                        continue;
                    const fn = member as FunctionDecl;
                    if (fn.name.startsWith("~")) continue;
                    if (!programAnalysis.templateMethods.has(structDeclaration.name))
                        programAnalysis.templateMethods.set(structDeclaration.name, new Map());
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
                    if (fn.params[0])
                        into.set(
                            `${akey}@${programAnalysis.typeKey(programAnalysis.derefType(fn.params[0].type))}`,
                            def,
                        );
                    if (!into.has(akey)) into.set(akey, def);
                    const firstDefault = fn.params.findIndex(
                        (param) => param.defaultValue !== undefined,
                    );
                    if (firstDefault >= 0) {
                        for (let arity = firstDefault; arity < fn.params.length; arity++) {
                            const defaultKey = `${fn.name}/${arity}`;
                            if (!into.has(defaultKey)) into.set(defaultKey, def);
                        }
                    }
                    if (!into.has(fn.name)) into.set(fn.name, def);
                }
            }
            // file-scope structs can still nest constants/enums (e.g. a contract's static constexpr)
            programAnalysis.collectConstants(structDeclaration.members);
        } else if (declaration.kind === AstKind.CLASS_TEMPLATE) {
            const ct = declaration as any;
            programAnalysis.captureMemberNamespaceContexts(ct.members, lookupContext);
            if (ct.hasBody === false) continue;
            // Keep the primary template and index each partial specialization separately.
            if (ct.specializationArgs) {
                if (!programAnalysis.specializations.has(ct.name))
                    programAnalysis.specializations.set(ct.name, []);
                programAnalysis.specializations.get(ct.name)!.push({
                    specArgs: ct.specializationArgs,
                    templateDeclaration: {
                        params: ct.params,
                        members: ct.members,
                        bases: ct.bases,
                    },
                });
            } else {
                const existing = programAnalysis.templates.get(ct.name);
                if (!existing || (ct.members?.length ?? 0) >= existing.members.length) {
                    programAnalysis.templates.set(ct.name, {
                        params: ct.params,
                        members: ct.members,
                        bases: ct.bases,
                    });
                }
            }
            // Capture inline methods, including templates, so call-site types can complete their
            // bindings lazily.
            for (const classMember of ct.specializationArgs ? [] : ct.members) {
                if (
                    (classMember.kind !== AstKind.FUNCTION &&
                        classMember.kind !== AstKind.FUNCTION_TEMPLATE) ||
                    !(classMember as FunctionDecl | FunctionTemplateDecl).body
                )
                    continue;
                const memberDeclaration = classMember as FunctionDecl | FunctionTemplateDecl;
                if (!programAnalysis.templateMethods.has(ct.name))
                    programAnalysis.templateMethods.set(ct.name, new Map());
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
                if (functionParameters[0])
                    into.set(
                        `${akey}@${programAnalysis.typeKey(programAnalysis.derefType(functionParameters[0].type))}`,
                        def,
                    );
                if (!into.has(akey)) into.set(akey, def);
                if (!into.has(functionName)) into.set(functionName, def);
            }
        } else if (
            declaration.kind === AstKind.FUNCTION_TEMPLATE ||
            declaration.kind === AstKind.FUNCTION
        ) {
            // out-of-class template method definition: HashMap::set, Collection::add, ...
            const fn = declaration as FunctionTemplateDecl;
            const sep = fn.name.lastIndexOf("::");
            // Single-level NS::fn free function (not Class::method): owner is neither a known template nor struct.
            const owner = sep > 0 ? fn.name.slice(0, sep) : "";
            const ownerBase = owner.includes("::")
                ? owner.slice(owner.lastIndexOf("::") + 2)
                : owner;
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
                if (!programAnalysis.libFns.has(key))
                    programAnalysis.libFns.set(key, declaration as FunctionDecl);
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
                if (!programAnalysis.templateMethods.has(cls))
                    programAnalysis.templateMethods.set(cls, new Map());
                // first definition wins (skip explicit specializations like HashFunction<m256i>)
                const minto = programAnalysis.templateMethods.get(cls)!;
                const makey = `${method}/${(fn.functionParameters ?? (fn as any).params ?? []).length}`;
                // Key explicit specializations by their concrete first parameter.
                if (
                    methodDefinition.params.length === 0 &&
                    methodDefinition.functionParameters?.length
                ) {
                    const concrete = programAnalysis.derefType(
                        methodDefinition.functionParameters[0].type,
                    );
                    minto.set(`${makey}@${programAnalysis.typeKey(concrete)}`, methodDefinition);
                }
                if (!minto.has(makey)) minto.set(makey, methodDefinition);
                if (!minto.has(method)) minto.set(method, methodDefinition);
            } else if (
                sep < 0 &&
                declaration.kind === AstKind.FUNCTION &&
                (declaration as FunctionDecl).body
            ) {
                // Index namespace and platform helpers by qualified name for lazy compilation.
                const key = `${nsPrefix}${fn.name}`;
                const overloads = programAnalysis.libFnOverloads.get(key);
                if (overloads) overloads.push(declaration as FunctionDecl);
                else programAnalysis.libFnOverloads.set(key, [declaration as FunctionDecl]);
                if (!programAnalysis.libFns.has(key))
                    programAnalysis.libFns.set(key, declaration as FunctionDecl);
            } else if (sep < 0 && declaration.kind === AstKind.FUNCTION_TEMPLATE && fn.body) {
                // Index namespace function templates by qualified name for call-site instantiation.
                const key = `${nsPrefix}${fn.name}`;
                const list = programAnalysis.libFnTemplates.get(key);
                if (list) list.push(fn as FunctionTemplateDecl);
                else programAnalysis.libFnTemplates.set(key, [fn as FunctionTemplateDecl]);
            }
        } else if (declaration.kind === AstKind.TYPEDEF_DECL) {
            programAnalysis.typedefs.set(td.name, td.type);
        } else if (declaration.kind === AstKind.VARIABLE) {
            programAnalysis.collectConstant(declaration as VariableDecl);
        } else if (declaration.kind === AstKind.ENUM) {
            programAnalysis.collectEnum(declaration as any);
        }
    }
}

export function captureMemberNamespaceContexts(
    programAnalysis: ProgramAnalysis,
    members: Declaration[],
    namespaceContext: NamespaceLookupContext,
): void {
    for (const member of members) {
        programAnalysis.namespaceContexts.set(member, namespaceContext);
        if (member.kind === AstKind.STRUCT || member.kind === AstKind.CLASS_TEMPLATE) {
            programAnalysis.captureMemberNamespaceContexts(
                (member as StructDecl).members,
                namespaceContext,
            );
        }
    }
}

export function namespaceContextOf(
    programAnalysis: ProgramAnalysis,
    declaration?: object | null,
): NamespaceLookupContext {
    return declaration
        ? (programAnalysis.namespaceContexts.get(declaration) ?? { usingNamespaces: [] })
        : { usingNamespaces: [] };
}

export function namespaceCandidates(
    name: string,
    sourceNamespace?: string,
    usingNamespaces: string[] = [],
): string[] {
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
        if (member.kind === AstKind.VARIABLE)
            programAnalysis.collectConstant(member as VariableDecl);
        else if (member.kind === AstKind.ENUM) programAnalysis.collectEnum(member as any);
    }
}

export function registerLibFnTemplate(
    programAnalysis: ProgramAnalysis,
    key: string,
    fn: FunctionTemplateDecl,
): void {
    if (!fn.body) return;
    const list = programAnalysis.libFnTemplates.get(key);
    if (list) list.push(fn);
    else programAnalysis.libFnTemplates.set(key, [fn]);
}

export function collectConstant(
    programAnalysis: ProgramAnalysis,
    variableDeclaration: VariableDecl,
): void {
    if (
        variableDeclaration.initializer &&
        (variableDeclaration.isConstexpr || variableDeclaration.type.kind === AstKind.CONST)
    ) {
        // User constants shadow seeded qpi.h constants with the same unqualified name.
        programAnalysis.constexprInit.set(
            variableDeclaration.name,
            variableDeclaration.initializer,
        );
        programAnalysis.constexprType.set(variableDeclaration.name, variableDeclaration.type);
        programAnalysis.enumConst.delete(variableDeclaration.name);
        programAnalysis.enumConstType.delete(variableDeclaration.name);
        programAnalysis.constCache.delete(variableDeclaration.name);
    }
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
): void {
    if (type.name) {
        programAnalysis.enumNames.add(type.name);
    }
    if (type.name && type.underlyingType?.kind === AstKind.NAME) {
        const byteSize = SCALAR_SIZE[type.underlyingType.name];
        if (byteSize !== undefined) programAnalysis.enumSize.set(type.name, byteSize);
        programAnalysis.enumUnderlying.set(type.name, type.underlyingType);
    }
    const enumType: TypeSpec = type.underlyingType ?? { kind: AstKind.NAME, name: "sint32" };
    let next = 0n;
    for (const member of type.members) {
        const numericValue = member.value
            ? programAnalysis.evalConstBig(member.value, EMPTY_TEMPLATE_BINDINGS)
            : next;
        next = numericValue + 1n;
        programAnalysis.constexprInit.delete(member.name);
        programAnalysis.constexprType.delete(member.name);
        programAnalysis.enumConst.set(
            member.name,
            programAnalysis.normalizeConst(numericValue, enumType),
        );
        programAnalysis.enumConstType.set(member.name, enumType);
        programAnalysis.constCache.delete(member.name);
        if (type.name) {
            programAnalysis.enumConst.set(
                `${type.name}::${member.name}`,
                programAnalysis.normalizeConst(numericValue, enumType),
            );
            programAnalysis.enumConstType.set(`${type.name}::${member.name}`, enumType);
            programAnalysis.constCache.delete(`${type.name}::${member.name}`);
        }
    }
}
