import { AstKind } from "../../shared/enums";
// Validation runs after parse and before codegen.
import type { Declaration, StructDecl, FunctionDecl, VariableDecl, Expression, TypeSpec, Span } from "../../ast";
import { unwrapType, isConstType, evalIntegralConst, typeKey, paramSignature } from "./validation-helpers";
import type { Validator } from "./validator";
import type { FnSig } from "./validator-context";

export function canonTypeKey(validator: Validator, type: TypeSpec): string {
    const unwrappedType = unwrapType(type);
    // Canonicalize constant template arguments so equal values compare equal.
    if (unwrappedType.kind === AstKind.TEMPLATE_INSTANCE) {
        const callArguments = unwrappedType.callArguments.map((argument) => {
            if (argument.kind === AstKind.NAME) {
                const numericValue = validator.constants.get(argument.name);
                if (numericValue !== undefined) {
                    return numericValue.toString();
                }
            }
            return validator.canonTypeKey(argument);
        });
        return `${unwrappedType.name}<${callArguments.join(",")}>`;
    }
    let text = typeKey(unwrappedType);
    for (let index = 0; index < 8; index++) {
        const next = validator.typeAliases.get(text);
        if (!next || next === text) {
            break;
        }
        text = next;
    }
    return text;
}

export function runTopLevel(validator: Validator, declarations: Declaration[]): void {
    const typeNames = new Set<string>();
    for (const declaration of declarations) {
        const isForwardDecl = (declaration.kind === AstKind.STRUCT || declaration.kind === AstKind.CLASS_TEMPLATE) && declaration.hasBody === false;
        if (
            (declaration.kind === AstKind.STRUCT ||
                declaration.kind === AstKind.CLASS_TEMPLATE ||
                declaration.kind === AstKind.ENUM ||
                declaration.kind === AstKind.TYPEDEF_DECL) &&
            declaration.name &&
            !isForwardDecl
        ) {
            // A specialization declares a different entity from the primary template, so it is keyed by
            // its arguments too: `template <> struct Tag<uint8>` and `template <typename T> struct Tag`
            // coexist, while two specializations over the same arguments still collide.
            const specializationArgs = (declaration as { specializationArgs?: TypeSpec[] }).specializationArgs;
            const declared = specializationArgs?.length
                ? `${declaration.name}<${specializationArgs.map((argument) => typeKey(unwrapType(argument))).join(",")}>`
                : declaration.name;

            if (typeNames.has(declared)) validator.error(`duplicate type definition '${declaration.name}'`, declaration.span);
            typeNames.add(declared);
        }
        if (declaration.kind === AstKind.TYPEDEF_DECL && declaration.name) {
            validator.typeAliases.set(
                declaration.name,
                typeKey(
                    unwrapType(
                        (
                            declaration as {
                                type: TypeSpec;
                            }
                        ).type,
                    ),
                ),
            );
        }
        switch (declaration.kind) {
            case AstKind.VARIABLE:
                validator.checkGlobalVariable(declaration);
                break;
            case AstKind.STRUCT:
                validator.checkStruct(declaration);
                break;
            case AstKind.NAMESPACE:
                validator.runTopLevel(declaration.body);
                break;
            case AstKind.FUNCTION:
                if (declaration.body) {
                    validator.checkFunctionBody(declaration, new Map());
                }
                break;
            case AstKind.ENUM:
                validator.collectEnumConstants(declaration);
                break;
            case AstKind.STATIC_ASSERT_DECL:
                validator.checkStaticAssert(declaration.condition, declaration.message, declaration.span);
                break;
            case AstKind.CLASS_TEMPLATE:
                validator.checkStruct(declaration as unknown as StructDecl);
                break;
        }
    }
}

export function checkGlobalVariable(validator: Validator, variableDeclaration: VariableDecl): void {
    if (variableDeclaration.isConstexpr || variableDeclaration.isExtern || isConstType(variableDeclaration.type)) {
        // File-scope constexpr constants feed template-argument canonicalization (canonTypeKey) and static_assert evaluation.
        if (variableDeclaration.initializer) {
            const value = evalIntegralConst(variableDeclaration.initializer, (name) => validator.constants.get(name) ?? null);
            if (value !== null) {
                validator.constants.set(variableDeclaration.name, value);
            }
        }
        return;
    }
    validator.error(
        `global variable '${variableDeclaration.name}' is not allowed in a contract — state must live in the contract state struct`,
        variableDeclaration.span,
    );
}

export function checkStruct(validator: Validator, structDeclaration: StructDecl): void {
    if (structDeclaration.name) validator.aggregateNames.add(structDeclaration.name);
    if (structDeclaration.hasBody === false) return;
    if (structDeclaration.name)
        validator.aggregateFieldCount.set(
            structDeclaration.name,
            structDeclaration.members.filter((member) => member.kind === AstKind.VARIABLE && !member.isStatic && !member.isConstexpr).length,
        );
    if (structDeclaration.name)
        validator.structFields.set(
            structDeclaration.name,
            new Map(
                structDeclaration.members
                    .filter((member): member is VariableDecl => member.kind === AstKind.VARIABLE)
                    .map((variableDeclaration) => [variableDeclaration.name, variableDeclaration.type]),
            ),
        );
    const fieldNames = new Set<string>();
    const typeNames = new Set<string>();
    const fnBodies = new Map<string, FunctionDecl>();
    const fnSigs = new Map<string, FnSig>();
    // F67: a nested type and a member function sharing a name — C++ hides the type behind the function
    // ([basic.scope.hiding]/2), so a bare use of that type after the function is declared is an error clang
    // rejects. Qinit has no elaborated `struct T` form, so reject it too rather than silently resolving the type.
    const seenFnNames = new Set<string>();
    const scopeTypeNames = new Set<string>();
    for (const typeMember of structDeclaration.members) {
        const forwardDecl = (typeMember.kind === AstKind.STRUCT || typeMember.kind === AstKind.CLASS_TEMPLATE) && typeMember.hasBody === false;
        if (
            (typeMember.kind === AstKind.STRUCT ||
                typeMember.kind === AstKind.CLASS_TEMPLATE ||
                typeMember.kind === AstKind.ENUM ||
                typeMember.kind === AstKind.TYPEDEF_DECL) &&
            typeMember.name &&
            !forwardDecl
        )
            scopeTypeNames.add(typeMember.name);
    }
    const collectTypeUses = (type: TypeSpec, out: { name: string; span?: Span }[]): void => {
        switch (type.kind) {
            case AstKind.NAME:
                out.push({ name: type.name, span: type.span });
                break;
            case AstKind.TEMPLATE_INSTANCE:
                out.push({ name: type.name, span: type.span });
                for (const argument of type.callArguments) collectTypeUses(argument, out);
                break;
            case AstKind.CONST:
                collectTypeUses(type.valueType, out);
                break;
            case AstKind.REFERENCE:
                collectTypeUses(type.referentType, out);
                break;
            case AstKind.POINTER:
                collectTypeUses(type.pointee, out);
                break;
            case AstKind.ARRAY:
                collectTypeUses(type.element, out);
                break;
            case AstKind.DEPENDENT_MEMBER:
                collectTypeUses(type.base, out);
                break;
        }
    };
    const gatherFieldUses = (members: Declaration[], out: { name: string; span?: Span }[]): void => {
        for (const field of members) {
            if (field.kind === AstKind.VARIABLE) collectTypeUses(field.type, out);
            else if (field.kind === AstKind.STRUCT && field.hasBody !== false) gatherFieldUses(field.members, out);
        }
    };
    const flagHiddenTypeUses = (uses: { name: string; span?: Span }[], fallback: Span): void => {
        for (const use of uses) {
            if (scopeTypeNames.has(use.name) && seenFnNames.has(use.name))
                validator.error(
                    `type '${use.name}' is hidden by a procedure or function of the same name; C++ requires the elaborated 'struct ${use.name}' here, which Qinit does not support — rename the type or the entry`,
                    use.span ?? fallback,
                );
        }
    };
    for (const member of structDeclaration.members) {
        const isForwardDecl = (member.kind === AstKind.STRUCT || member.kind === AstKind.CLASS_TEMPLATE) && member.hasBody === false;
        if (
            (member.kind === AstKind.STRUCT ||
                member.kind === AstKind.CLASS_TEMPLATE ||
                member.kind === AstKind.ENUM ||
                member.kind === AstKind.TYPEDEF_DECL) &&
            member.name &&
            !isForwardDecl
        ) {
            if (typeNames.has(member.name)) validator.error(`duplicate type definition '${member.name}' in struct '${structDeclaration.name}'`, member.span);
            typeNames.add(member.name);
        }
        if (member.kind === AstKind.TYPEDEF_DECL && member.name) {
            validator.typeAliases.set(
                member.name,
                typeKey(
                    unwrapType(
                        (
                            member as {
                                type: TypeSpec;
                            }
                        ).type,
                    ),
                ),
            );
        }
        if (member.kind === AstKind.VARIABLE) {
            // Anonymous-union alternatives intentionally alias storage; only named duplicates in the same struct are redefinitions.
            if (fieldNames.has(member.name)) {
                validator.error(`duplicate member '${member.name}' in struct '${structDeclaration.name}'`, member.span);
            }
            fieldNames.add(member.name);
            const variableUses: { name: string; span?: Span }[] = [];
            collectTypeUses(member.type, variableUses);
            flagHiddenTypeUses(variableUses, member.span);
            if (member.initializer && (member.isConstexpr || isConstType(member.type))) {
                const value = evalIntegralConst(member.initializer, (name) => validator.constants.get(name) ?? null);
                if (value !== null) validator.constants.set(member.name, value);
            }
        }
        if (member.kind === AstKind.STRUCT) {
            if (member.name) validator.aggregateNames.add(member.name);
            const nestedUses: { name: string; span?: Span }[] = [];
            gatherFieldUses(member.members, nestedUses);
            flagHiddenTypeUses(nestedUses, member.span);
            validator.checkStruct(member);
        }
        if (member.kind === AstKind.ENUM) {
            validator.collectEnumConstants(member);
        }
        if (member.kind === AstKind.STATIC_ASSERT_DECL) {
            validator.checkStaticAssert(member.condition, member.message, member.span);
        }
        if (member.kind === AstKind.FUNCTION) {
            seenFnNames.add(member.name);
            const sig: FnSig = {
                declaration: member,
                minArgs: member.params.filter((parameter) => !parameter.defaultValue).length,
                maxArgs: member.params.length,
            };
            if (member.body) {
                // A second definition with the same parameter signature is a redefinition; overloads differ in signature.
                const prev = fnBodies.get(member.name);
                if (prev && paramSignature(prev) === paramSignature(member)) {
                    validator.error(`'${member.name}' is already defined in struct '${structDeclaration.name}' with the same signature`, member.span);
                }
                if (!prev) {
                    fnBodies.set(member.name, member);
                }
                if (!fnSigs.has(member.name) || fnSigs.get(member.name)!.declaration.body === undefined) {
                    fnSigs.set(member.name, sig);
                }
            } else if (!fnSigs.has(member.name)) {
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
        validator.checkFunctionBody(fn, fnSigs);
    }
    validator.checkRecursion(structDeclaration, fnBodies);
}

export function collectEnumConstants(
    validator: Validator,
    entry: Declaration & {
        kind: AstKind.ENUM;
    },
): void {
    const names = new Set<string>();
    let next = 0n;
    for (const member of entry.members) {
        if (names.has(member.name)) validator.error(`duplicate enumerator '${member.name}'`, member.span);
        names.add(member.name);
        const value = member.value ? evalIntegralConst(member.value, (name) => validator.constants.get(name) ?? null) : next;
        if (value !== null) {
            validator.constants.set(member.name, value);
            if (entry.name) validator.constants.set(`${entry.name}::${member.name}`, value);
            next = value + 1n;
        }
    }
}

export function checkStaticAssert(validator: Validator, condition: Expression, message: Expression | undefined, span: Span): void {
    const value = evalIntegralConst(condition, (name) => validator.constants.get(name) ?? null);
    if (value === 0n) {
        const detail = message?.kind === AstKind.STRING_LITERAL ? `: ${message.value}` : "";
        validator.error(`static assertion failed${detail}`, span);
    }
}
