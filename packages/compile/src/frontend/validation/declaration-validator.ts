import { AstKind } from "../../enums";
// Validation runs after parse and before codegen.
import type { Declaration, StructDecl, FunctionDecl, VariableDecl, Expression, TypeSpec, Span } from "../../ast";
import { unwrapType, isConstType, evalIntegralConst, typeKey, paramSignature } from "./validation-helpers";
import type { FnSig, ValidatorInternals } from "./validator-context";

export function canonTypeKey(context: ValidatorInternals, type: TypeSpec): string {
    const unwrappedType = unwrapType(type);
    // Canonicalize constant template arguments so equal values compare equal.
    if (unwrappedType.kind === AstKind.TEMPLATE_INSTANCE) {
        const callArguments = unwrappedType.callArguments.map((argument) => {
            if (argument.kind === AstKind.NAME) {
                const numericValue = context.constants.get(argument.name);
                if (numericValue !== undefined) {
                    return numericValue.toString();
                }
            }
            return context.canonTypeKey(argument);
        });
        return `${unwrappedType.name}<${callArguments.join(",")}>`;
    }
    let text = typeKey(unwrappedType);
    for (let index = 0; index < 8; index++) {
        const next = context.typeAliases.get(text);
        if (!next || next === text) {
            break;
        }
        text = next;
    }
    return text;
}

export function runTopLevel(context: ValidatorInternals, declarations: Declaration[]): void {
    const typeNames = new Set<string>();
    for (const declaration of declarations) {
        const isForwardDecl = (
            declaration.kind === AstKind.STRUCT ||
            declaration.kind === AstKind.CLASS_TEMPLATE
        ) && declaration.hasBody === false;
        if ((declaration.kind === AstKind.STRUCT ||
            declaration.kind === AstKind.CLASS_TEMPLATE ||
            declaration.kind === AstKind.ENUM ||
            declaration.kind === AstKind.TYPEDEF_DECL) &&
            declaration.name &&
            !isForwardDecl) {
            if (typeNames.has(declaration.name))
                context.error(`duplicate type definition '${declaration.name}'`, declaration.span);
            typeNames.add(declaration.name);
        }
        if (declaration.kind === AstKind.TYPEDEF_DECL && declaration.name) {
            context.typeAliases.set(declaration.name, typeKey(unwrapType((declaration as {
                type: TypeSpec;
            }).type)));
        }
        switch (declaration.kind) {
            case AstKind.VARIABLE:
                context.checkGlobalVariable(declaration);
                break;
            case AstKind.STRUCT:
                context.checkStruct(declaration);
                break;
            case AstKind.NAMESPACE:
                context.runTopLevel(declaration.body);
                break;
            case AstKind.FUNCTION:
                if (declaration.body) {
                    context.checkFunctionBody(declaration, new Map());
                }
                break;
            case AstKind.ENUM:
                context.collectEnumConstants(declaration);
                break;
            case AstKind.STATIC_ASSERT_DECL:
                context.checkStaticAssert(declaration.condition, declaration.message, declaration.span);
                break;
            case AstKind.CLASS_TEMPLATE:
                context.checkStruct(declaration as unknown as StructDecl);
                break;
        }
    }
}

export function checkGlobalVariable(context: ValidatorInternals, variableDeclaration: VariableDecl): void {
    if (variableDeclaration.isConstexpr || variableDeclaration.isExtern || isConstType(variableDeclaration.type)) {
        // File-scope constexpr constants feed template-argument canonicalization (canonTypeKey) and static_assert evaluation.
        if (variableDeclaration.initializer) {
            const value = evalIntegralConst(variableDeclaration.initializer, (name) => context.constants.get(name) ?? null);
            if (value !== null) {
                context.constants.set(variableDeclaration.name, value);
            }
        }
        return;
    }
    context.error(`global variable '${variableDeclaration.name}' is not allowed in a contract — state must live in the contract state struct`, variableDeclaration.span);
}

export function checkStruct(context: ValidatorInternals, structDeclaration: StructDecl): void {
    if (structDeclaration.name)
        context.aggregateNames.add(structDeclaration.name);
    if (structDeclaration.hasBody === false)
        return;
    if (structDeclaration.name)
        context.aggregateFieldCount.set(structDeclaration.name, structDeclaration.members.filter((member) => member.kind === AstKind.VARIABLE && !member.isStatic && !member.isConstexpr).length);
    if (structDeclaration.name)
        context.structFields.set(structDeclaration.name, new Map(structDeclaration.members
            .filter((member): member is VariableDecl => member.kind === AstKind.VARIABLE)
            .map((variableDeclaration) => [variableDeclaration.name, variableDeclaration.type])));
    const fieldNames = new Set<string>();
    const typeNames = new Set<string>();
    const fnBodies = new Map<string, FunctionDecl>();
    const fnSigs = new Map<string, FnSig>();
    for (const member of structDeclaration.members) {
        const isForwardDecl = (
            member.kind === AstKind.STRUCT ||
            member.kind === AstKind.CLASS_TEMPLATE
        ) && member.hasBody === false;
        if ((member.kind === AstKind.STRUCT ||
            member.kind === AstKind.CLASS_TEMPLATE ||
            member.kind === AstKind.ENUM ||
            member.kind === AstKind.TYPEDEF_DECL) &&
            member.name &&
            !isForwardDecl) {
            if (typeNames.has(member.name))
                context.error(`duplicate type definition '${member.name}' in struct '${structDeclaration.name}'`, member.span);
            typeNames.add(member.name);
        }
        if (member.kind === AstKind.TYPEDEF_DECL && member.name) {
            context.typeAliases.set(member.name, typeKey(unwrapType((member as {
                type: TypeSpec;
            }).type)));
        }
        if (member.kind === AstKind.VARIABLE) {
            // Anonymous-union alternatives intentionally alias storage; only named duplicates in the same struct are redefinitions.
            if (fieldNames.has(member.name)) {
                context.error(`duplicate member '${member.name}' in struct '${structDeclaration.name}'`, member.span);
            }
            fieldNames.add(member.name);
            if (member.initializer && (member.isConstexpr || isConstType(member.type))) {
                const value = evalIntegralConst(member.initializer, (name) => context.constants.get(name) ?? null);
                if (value !== null)
                    context.constants.set(member.name, value);
            }
        }
        if (member.kind === AstKind.STRUCT) {
            if (member.name)
                context.aggregateNames.add(member.name);
            context.checkStruct(member);
        }
        if (member.kind === AstKind.ENUM) {
            context.collectEnumConstants(member);
        }
        if (member.kind === AstKind.STATIC_ASSERT_DECL) {
            context.checkStaticAssert(member.condition, member.message, member.span);
        }
        if (member.kind === AstKind.FUNCTION) {
            const sig: FnSig = {
                declaration: member,
                minArgs: member.params.filter((parameter) => !parameter.defaultValue).length,
                maxArgs: member.params.length,
            };
            if (member.body) {
                // Two definitions with the same parameter signature are a redefinition. Overloads
                const prev = fnBodies.get(member.name);
                if (prev && paramSignature(prev) === paramSignature(member)) {
                    context.error(`'${member.name}' is already defined in struct '${structDeclaration.name}' with the same signature`, member.span);
                }
                if (!prev) {
                    fnBodies.set(member.name, member);
                }
                if (!fnSigs.has(member.name) || fnSigs.get(member.name)!.declaration.body === undefined) {
                    fnSigs.set(member.name, sig);
                }
            }
            else if (!fnSigs.has(member.name)) {
                fnSigs.set(member.name, sig);
            }
        }
    }
    // Overloaded names can't be arity-checked or default-desugared without type-based resolution — exclude them from call checks entirely.
    const bodyCount = new Map<string, number>();
    for (const memberCandidate of structDeclaration.members) {
        if (memberCandidate.kind === AstKind.FUNCTION && memberCandidate.body) {
            bodyCount.set(memberCandidate.name, (bodyCount.get(memberCandidate.name) ?? 0) + 1);
        }
    }
    for (const [name, n] of bodyCount) {
        if (n > 1) {
            fnSigs.delete(name);
        }
    }
    for (const fn of fnBodies.values()) {
        context.checkFunctionBody(fn, fnSigs);
    }
    context.checkRecursion(structDeclaration, fnBodies);
}

export function collectEnumConstants(context: ValidatorInternals, entry: Declaration & {
    kind: AstKind.ENUM;
}): void {
    const names = new Set<string>();
    let next = 0n;
    for (const member of entry.members) {
        if (names.has(member.name))
            context.error(`duplicate enumerator '${member.name}'`, member.span);
        names.add(member.name);
        const value = member.value
            ? evalIntegralConst(member.value, (name) => context.constants.get(name) ?? null)
            : next;
        if (value !== null) {
            context.constants.set(member.name, value);
            if (entry.name)
                context.constants.set(`${entry.name}::${member.name}`, value);
            next = value + 1n;
        }
    }
}

export function checkStaticAssert(context: ValidatorInternals, condition: Expression, message: Expression | undefined, span: Span): void {
    const value = evalIntegralConst(condition, (name) => context.constants.get(name) ?? null);
    if (value === 0n) {
        const detail = message?.kind === AstKind.STRING_LITERAL ? `: ${message.value}` : "";
        context.error(`static assertion failed${detail}`, span);
    }
}
