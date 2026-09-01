import { AstKind, BinaryOp, WatNodeType } from "../../../shared/enums";
import type { Expression, FunctionDecl, FunctionTemplateDecl, StructDecl, TypeSpec } from "../../../ast";
import * as watIr from "../wat-ir";
import { EMPTY_TEMPLATE_BINDINGS, type CompiledHelperMetadata, type FunctionEmissionContext } from "../types";
import { addrIr, narrowCastIr } from "../memory/memory-operations";
import { compileLibraryFunction } from "../calls/library-function-compiler";

// C++ resolves every operator through overload resolution, so the lowering asks the type what it
// declared rather than assuming a representation. Member candidates are asked first, then non-member
// ones — at namespace scope or declared `friend` — since a type you do not own can only be given an
// operator from outside it. m256i is the exception: its operators are declared at namespace scope too,
// but their bodies are x86 intrinsics the caller substitutes for instead of lowering.

// Walk typedefs and template bindings to the type a member lookup can use — `id` to `m256i`, and a
// container's `KeyT` to whatever the instantiation bound it to.
export function concreteType(context: FunctionEmissionContext, type: TypeSpec | null | undefined): TypeSpec | null {
    let resolved: TypeSpec | null = type ?? null;

    for (let depth = 0; depth < 8 && resolved?.kind === AstKind.NAME; depth++) {
        const next: TypeSpec | undefined = context.thisBind?.types.get(resolved.name) ?? context.programAnalysis.typedefs.get(resolved.name);

        if (!next) {
            break;
        }

        resolved = next;
    }

    return resolved;
}

// Arithmetic keeps the class of its operands; a comparison or a logical operator yields `bool`
// whatever its operands were, so those do not carry a class through.
const VALUE_PRESERVING_OPERATORS: ReadonlySet<string> = new Set([
    BinaryOp.ADD,
    BinaryOp.SUBTRACT,
    BinaryOp.MULTIPLY,
    BinaryOp.DIVIDE,
    BinaryOp.MODULO,
    BinaryOp.BITWISE_AND,
    BinaryOp.BITWISE_OR,
    BinaryOp.BITWISE_XOR,
    BinaryOp.SHIFT_LEFT,
    BinaryOp.SHIFT_RIGHT,
]);

// A helper call's declared return type, read from the index. Never through lookupHelper, which
// compiles the helper: typing an operand must not emit code or fail a build.
function helperResultType(context: FunctionEmissionContext, expression: Expression): TypeSpec | null {
    if (expression.kind !== AstKind.CALL && expression.kind !== AstKind.TEMPLATE_CALL) {
        return null;
    }

    const callee = expression.callee;

    if (callee.kind !== AstKind.IDENTIFIER && callee.kind !== AstKind.QUALIFIED_NAME) {
        return null;
    }

    const programAnalysis = context.programAnalysis;
    // A contract's own helpers register their metadata, return type included, before any body is
    // lowered, so this reads a value that is already there.
    const compiledOverloads = programAnalysis.helperOverloads.get(callee.name) ?? [];
    const compiled = compiledOverloads.length ? compiledOverloads : [programAnalysis.helpers.get(callee.name)].filter((entry) => entry !== undefined);

    if (compiled.length) {
        const returnTypes = compiled.map((entry) => entry!.retType).filter((type) => type !== undefined);

        return returnTypes.length === compiled.length && new Set(returnTypes.map((type) => programAnalysis.typeKey(type!))).size === 1 ? returnTypes[0]! : null;
    }

    for (const key of programAnalysis.namespaceCandidates(callee.name, context.sourceNamespace, context.usingNamespaces)) {
        const overloads = programAnalysis.libFnOverloads.get(key) ?? (programAnalysis.libFns.has(key) ? [programAnalysis.libFns.get(key)!] : []);

        if (overloads.length) {
            const declared = overloads.map((overload) => programAnalysis.derefType(overload.returnType));
            const distinct = new Set(declared.map((type) => programAnalysis.typeKey(type)));

            // Overloads that disagree on their return type say nothing about this call.
            return distinct.size === 1 ? declared[0] : null;
        }

        const templates = programAnalysis.libFnTemplates.get(key);

        if (templates?.length) {
            return templateResultType(context, templates[0], expression);
        }
    }

    return null;
}

// Substitute a call's explicit template arguments into the template's declared return type, so
// div<uint128>(a, b) reads as uint128_t.
function templateResultType(context: FunctionEmissionContext, template: FunctionTemplateDecl, expression: Expression): TypeSpec | null {
    const explicit = (expression as { templateArguments?: TypeSpec[] }).templateArguments ?? [];
    const types = new Map<string, TypeSpec>();

    template.params.forEach((parameter, index) => {
        if (parameter.kind === AstKind.TYPE && explicit[index]) {
            types.set(parameter.name, explicit[index]);
        }
    });

    if (!types.size) {
        return null;
    }

    return context.programAnalysis.substInBindings(context.programAnalysis.derefType(template.returnType), { ...EMPTY_TEMPLATE_BINDINGS, types });
}

// The class an operand belongs to, or null when it is a scalar or an unresolved type. The rvalue
// shapes are read from the syntax rather than through the address resolver, which would emit a call
// operand before an overload has claimed it.
export function classOperandName(context: FunctionEmissionContext, expression: Expression, depth = 0): string | null {
    const operand = classOperandType(context, expression, depth);
    return operand ? operand.name : null;
}

// $memeq/$m256_lt stand in for m256.h's operators, so they key on the type rather than on a 32-byte
// size — a user struct of the same width gets its own declared operator instead.
export function isM256Operand(context: FunctionEmissionContext, expression: Expression): boolean {
    const name = classOperandName(context, expression);

    if (!name) {
        return false;
    }

    const separator = name.lastIndexOf("::");
    const unqualified = separator >= 0 ? name.slice(separator + 2) : name;

    return unqualified === "m256i" || unqualified === "id";
}

/**
 * The class an operand belongs to, with its template arguments intact.
 *
 * The name alone is not enough to call an operator on: `K<uint16>` and `K<uint64>` share it, and a
 * body instantiated without the arguments reads its own fields at the wrong width.
 */
export function classOperandType(
    context: FunctionEmissionContext,
    expression: Expression,
    depth = 0,
): (TypeSpec & { kind: AstKind.NAME | AstKind.TEMPLATE_INSTANCE }) | null {
    if (depth < 8) {
        if (expression.kind === AstKind.PAREN) {
            return classOperandType(context, expression.expression, depth + 1);
        }

        if (expression.kind === AstKind.C_CAST || expression.kind === AstKind.STATIC_CAST) {
            const cast = concreteType(context, expression.type);
            if (cast?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(cast)) return cast;
            return classOperandType(context, expression.expression, depth + 1);
        }

        if (expression.kind === AstKind.BINARY_OP && VALUE_PRESERVING_OPERATORS.has(expression.operator)) {
            return classOperandType(context, expression.left, depth + 1) ?? classOperandType(context, expression.right, depth + 1);
        }

        if (expression.kind === AstKind.TERNARY) {
            return classOperandType(context, expression.then, depth + 1) ?? classOperandType(context, expression.else_, depth + 1);
        }

        // A helper's declared return type, then `Type(args)` naming its class in the callee. Helper
        // first, matching emitAddress, so an operand is typed by whatever will actually be emitted.
        const returned = concreteType(context, helperResultType(context, expression));

        if (returned?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(returned)) {
            return returned;
        }

        if (returned?.kind === AstKind.TEMPLATE_INSTANCE) {
            return returned;
        }

        if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.IDENTIFIER) {
            const constructed = concreteType(context, { kind: AstKind.NAME, name: expression.callee.name });

            if (constructed?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(constructed)) {
                return constructed;
            }
        }
    }

    const node = context.lowering.resolveExpressionAddress(context, expression);
    const resolved = concreteType(context, node?.type);

    if (resolved?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(resolved)) {
        return resolved;
    }

    return resolved?.kind === AstKind.TEMPLATE_INSTANCE ? resolved : null;
}

// Methods are indexed under both the qualified and the unqualified name depending on where the type
// was declared, so a lookup has to try both — QPI::DateAndTime declares its operators as DateAndTime.
export function operatorOwner(context: FunctionEmissionContext, className: string, operatorName: string, arity: number): TypeSpec | null {
    // Ask the class the name resolves to, and its bases, the way member lookup does. Asking the
    // name-keyed table instead reports whatever other class shares the spelling.
    const declaration = context.programAnalysis.structByName(className, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);

    // The walk covers the bases, so a class that inherits every method still finds one. It runs even
    // when the class owns no methods of its own, which is exactly when it has no table entry.
    const declarer = declaration ? operatorDeclarer(context, declaration, operatorName, arity, 0) : null;

    if (declarer) {
        return declarer;
    }

    // A class that does own methods has been asked and answered; consulting the name-keyed table now
    // would report whatever other class shares the spelling.
    if (declaration && context.programAnalysis.methodsByDeclaration.has(declaration)) {
        return null;
    }

    const separator = className.lastIndexOf("::");
    const candidates = separator >= 0 ? [className, className.slice(separator + 2)] : [className];

    for (const candidate of candidates) {
        const methods = context.programAnalysis.templateMethods.get(candidate);

        if (methods && (methods.has(`${operatorName}/${arity}`) || methods.has(operatorName))) {
            return { kind: AstKind.NAME, name: candidate };
        }
    }

    return null;
}

/**
 * Which class declares the operator: the one asked, or the base it inherits it from.
 *
 * The base is returned as the type the derived class names, template arguments included, because the
 * body belongs to that instantiation and has to be compiled against its bindings.
 */
function operatorDeclarer(context: FunctionEmissionContext, declaration: StructDecl, operatorName: string, arity: number, depth: number): TypeSpec | null {
    const methods = context.programAnalysis.methodsByDeclaration.get(declaration);

    if (methods && (methods.has(`${operatorName}/${arity}`) || methods.has(operatorName))) {
        return { kind: AstKind.NAME, name: declaration.name };
    }

    if (depth >= 8) {
        return null;
    }

    for (const base of declaration.bases ?? []) {
        const resolvedBase = context.programAnalysis.resolveType(base, EMPTY_TEMPLATE_BINDINGS);
        const baseName = context.programAnalysis.baseTemplateName(resolvedBase);
        if (!baseName) continue;

        const baseDeclaration = context.programAnalysis.structByName(baseName, EMPTY_TEMPLATE_BINDINGS);

        if (baseDeclaration) {
            // A plain base's methods reach the derived class through the owner-name walk, so the
            // class asked stays the target; only a template base has to name its instantiation.
            if (operatorDeclarer(context, baseDeclaration, operatorName, arity, depth + 1)) {
                return { kind: AstKind.NAME, name: declaration.name };
            }
            continue;
        }

        // A base that is a class template has no struct declaration behind its name; its members are
        // indexed under the template's own name, and its arguments live in the base type itself.
        const templateMethods = context.programAnalysis.templateMethods.get(baseName);
        if (templateMethods && (templateMethods.has(`${operatorName}/${arity}`) || templateMethods.has(operatorName))) {
            return resolvedBase;
        }
    }

    return null;
}

// Emit a call to the operator body the class declared. Mirrors sourceU128Result, which is the same
// call for one hardcoded type.
function callOperator(
    context: FunctionEmissionContext,
    ownerType: TypeSpec & { kind: AstKind.NAME | AstKind.TEMPLATE_INSTANCE },
    operatorName: string,
    self: Expression,
    operands: Expression[],
): {
    node: watIr.WatNode | null;
    aggregate: boolean;
} | null {
    const selfAddress = context.lowering.emitAddress(context, self);

    if (!selfAddress) {
        return null;
    }

    const owner: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    } = ownerType.kind === AstKind.TEMPLATE_INSTANCE ? ownerType : { kind: AstKind.TEMPLATE_INSTANCE, name: ownerType.name, callArguments: [] };
    const compiled = context.lowering.callCompiled(context, owner, operatorName, selfAddress, operands);

    if (!compiled) {
        return null;
    }

    return { node: compiledCallResult(context, compiled, `${owner.name}::${operatorName}`), aggregate: !!compiled.retDest };
}

// The class an operator is resolved on, or null when the operand has none.
function operatorTarget(
    context: FunctionEmissionContext,
    operatorName: string,
    left: Expression,
    arity: number,
): (TypeSpec & { kind: AstKind.NAME | AstKind.TEMPLATE_INSTANCE }) | null {
    const leftClass = classOperandType(context, left);
    if (!leftClass) return null;

    // The operator may be declared on a base, or under the unqualified spelling of a namespaced
    // class; the operand keeps its own arguments either way.
    const owner = operatorOwner(context, leftClass.name, operatorName, arity);
    if (!owner) return null;

    // A template base answers with its own instantiation, arguments included. A plain answer that
    // names the operand's own class gives the operand back, so its template arguments survive.
    if (owner.kind === AstKind.TEMPLATE_INSTANCE) return owner;
    if (owner.kind !== AstKind.NAME) return null;

    return owner.name === leftClass.name ? leftClass : owner;
}

/**
 * The address of an overloaded operator's result, for a body that returns its own class by value.
 *
 * Returns null when no candidate applies or the result is a scalar, leaving the caller to answer that
 * the expression has no address — which is what it had before this existed.
 */
export function overloadedOperatorAddress(context: FunctionEmissionContext, operatorName: string, left: Expression, right?: Expression): string | null {
    const operands = right ? [right] : [];
    const owner = operatorTarget(context, operatorName, left, operands.length);
    const called = owner ? callOperator(context, owner, operatorName, left, operands) : null;

    return called?.aggregate && called.node ? watIr.serializeWatNode(called.node) : null;
}

/** Turn a callCompiled result into the value node its return kind implies. */
export function compiledCallResult(
    context: FunctionEmissionContext,
    compiled: {
        call: string;
        cm: {
            retKind: WatNodeType;
        };
        retDest?: string;
    },
    label: string,
): watIr.WatNode | null {
    if (compiled.retDest) {
        context.lines.push(`    ${compiled.call}`);
        return watIr.rawWatNode(compiled.retDest, WatNodeType.I32, `${label} aggregate result`);
    }

    if (compiled.cm.retKind === WatNodeType.I64) {
        return watIr.rawWatNode(compiled.call, WatNodeType.I64, `${label} scalar result`);
    }

    if (compiled.cm.retKind === WatNodeType.I32) {
        return watIr.rawWatNode(compiled.call, WatNodeType.I32, `${label} reference result`);
    }

    context.lines.push(`    ${compiled.call}`);
    return null;
}

// The rewritten candidate is formed only for a bool-returning operator==; Clang rejects the rewrite
// for any other return type, so accepting it here would compile code the native build will not.
function equalityReturnsBool(context: FunctionEmissionContext, className: string | null): boolean {
    if (!className) {
        return false;
    }

    const declaration = context.programAnalysis.structByName(className, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    const owned = declaration ? context.programAnalysis.methodsByDeclaration.get(declaration) : undefined;
    const definition = (owned ?? context.programAnalysis.templateMethods.get(className))?.get("operator==/1");
    const returned = definition ? context.programAnalysis.derefType(definition.returnType) : null;

    return returned?.kind === AstKind.NAME && returned.name === "bool";
}

/**
 * Lower `left <op> right` (or a unary `<op> left`) through the operator the operand's class declares.
 *
 * Callers must pass operands that are already lvalues. Asking for an operand's type goes through
 * resolveExpressionAddress, which materializes a call expression — emitting it before we know an
 * overload wants it. `!f(x)` did exactly that and left HashFunc::hash unresolvable in QUtil.
 *
 * Returns null when no candidate applies, leaving the caller to fall back or report.
 */
/**
 * Whether a declared parameter accepts an operand of this class, comparing the types each side
 * actually resolves to so a typedef (`id` for `m256i`) still matches. A scalar operand carries no
 * class and only fits a parameter that is not an aggregate.
 */
function parameterAccepts(context: FunctionEmissionContext, parameterType: TypeSpec, operandClass: string | null): boolean {
    const declared = concreteType(context, context.programAnalysis.derefType(parameterType));

    if (declared?.kind !== AstKind.NAME) {
        return false;
    }

    if (!operandClass) {
        return !context.programAnalysis.isAggregateType(declared);
    }

    const operand = concreteType(context, { kind: AstKind.NAME, name: operandClass });

    return declared.name === operandClass || (operand?.kind === AstKind.NAME && declared.name === operand.name);
}

/**
 * A non-member operator — `operator==(const Asset&, const Asset&)` at namespace scope, the only way to
 * give a comparison to a type you do not own. C++ finds it by ordinary lookup plus ADL; its operands
 * are the arguments and there is no `this`, so candidate keys, lazy compilation and argument lowering
 * all come from the free-function call path rather than a second implementation of them here.
 *
 * The candidates are filtered by parameter type instead of ranked. `operator==` is declared many times
 * over at global scope — m256i alone contributes four — and a ranking that never rejects a non-viable
 * candidate answers a two-word struct with the 32-byte comparison, which compiles and is always false.
 */
function freeOperatorDeclaration(
    context: FunctionEmissionContext,
    operatorName: string,
    operands: Expression[],
): { key: string; declaration: FunctionDecl; owner?: StructDecl } | null {
    const programAnalysis = context.programAnalysis;
    const operandClasses = operands.map((operand) => classOperandName(context, operand));

    // Only a class operand can name a user-declared operator; an all-scalar expression is the built-in.
    if (!operandClasses.some((name) => name !== null)) {
        return null;
    }

    // m256.h declares its operators at namespace scope too, but their bodies are x86 intrinsics this
    // backend substitutes for rather than lowers. Claiming one here would call the body it stands in
    // for, which compiles and answers nothing.
    if (operands.some((operand) => isM256Operand(context, operand))) {
        return null;
    }

    for (const key of programAnalysis.namespaceCandidates(operatorName, context.sourceNamespace, context.usingNamespaces)) {
        const declarations = programAnalysis.libFnOverloads.get(key) ?? (programAnalysis.libFns.has(key) ? [programAnalysis.libFns.get(key)!] : []);

        for (const declaration of declarations) {
            if (declaration.params.length !== operands.length) {
                continue;
            }

            if (declaration.params.every((parameter, index) => parameterAccepts(context, parameter.type, operandClasses[index]))) {
                return { key, declaration };
            }
        }
    }

    // A `friend` operator is written inside the class but is still a non-member: it takes both operands
    // as arguments and has no `this`. It is kept as a member of the class that befriended it, wrapping
    // the function it declares.
    for (const operandClass of operandClasses) {
        const owner = operandClass ? context.programAnalysis.structByName(operandClass, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) : undefined;

        for (const member of owner?.members ?? []) {
            if (member.kind !== AstKind.FRIEND || member.declaration.kind !== AstKind.FUNCTION) {
                continue;
            }

            const declaration = member.declaration;

            if (declaration.name !== operatorName || declaration.params.length !== operands.length || !declaration.body) {
                continue;
            }

            if (declaration.params.every((parameter, index) => parameterAccepts(context, parameter.type, operandClasses[index]))) {
                return { key: `${operandClass}::${operatorName}`, declaration, owner };
            }
        }
    }

    return null;
}

// Whether the non-member equality chosen for these operands yields bool, the same condition the member
// path checks before rewriting `!=`.
function freeEqualityReturnsBool(context: FunctionEmissionContext, operands: Expression[]): boolean {
    const found = freeOperatorDeclaration(context, "operator==", operands);
    const returned = found ? context.programAnalysis.derefType(found.declaration.returnType) : null;

    return returned?.kind === AstKind.NAME && returned.name === "bool";
}

// The library compiler takes a free function; a friend already is one, so this only restates it in the
// shape that path expects.
function friendDefinition(name: string, declaration: FunctionDecl): FunctionTemplateDecl {
    return {
        kind: AstKind.FUNCTION_TEMPLATE,
        name,
        params: [],
        functionParameters: declaration.params,
        returnType: declaration.returnType,
        body: declaration.body,
        isConstexpr: declaration.isConstexpr,
        span: declaration.span,
    } as FunctionTemplateDecl;
}

// The operands as the call's arguments: an aggregate parameter takes an address, a scalar one the value
// narrowed to its declared width, which is what the library call path does for an ordinary call.
function operatorArgumentNodes(context: FunctionEmissionContext, info: CompiledHelperMetadata, operands: Expression[]): watIr.WatNode[] {
    return info.params.map((parameter, index) => {
        const argument = operands[index];

        if (parameter.isAddr) {
            const size = context.programAnalysis.sizeOfType(parameter.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);

            return addrIr(context.lowering.argAddr(context, argument, size, parameter.type, false, true));
        }

        const declared = context.programAnalysis.derefType(parameter.type);
        const value = narrowCastIr(context.lowering.lowerValueExpression(context, argument), declared.kind === AstKind.NAME ? declared.name : undefined);

        return parameter.wasmType === WatNodeType.I32 ? watIr.operation("i32.wrap_i64", value) : value;
    });
}

function tryLowerFreeOperator(context: FunctionEmissionContext, operatorName: string, operands: Expression[]): watIr.WatNode | null {
    const found = freeOperatorDeclaration(context, operatorName, operands);

    if (found) {
        const info = found.owner
            ? context.lowering.compileLibraryFunctionInstance(context, friendDefinition(found.key, found.declaration), operands)
            : compileLibraryFunction(context.programAnalysis, found.key, found.declaration, `${found.key}@${found.declaration.span?.line ?? 0}`);

        // An operator in an expression has to produce a value; an aggregate return is an address
        // and belongs on the address path, which asks separately.
        if (info && !info.retAgg && info.retIsValue) {
            // A library function returns on the i64 value channel, so the operator's result is one too.
            const signature = { params: info.params.map((parameter) => parameter.wasmType), res: WatNodeType.I64 };

            return watIr.functionCallWithSignature(signature, info.label, ...operatorArgumentNodes(context, info, operands));
        }
    }

    return null;
}

export function tryLowerOverloadedOperator(context: FunctionEmissionContext, operatorName: string, left: Expression, right?: Expression): watIr.WatNode | null {
    const operands = right ? [right] : [];
    const owner = operatorTarget(context, operatorName, left, operands.length);

    if (owner) {
        const called = callOperator(context, owner, operatorName, left, operands);
        const result = called?.node ?? null;

        // A comparison body returns `bit`, which this backend models as a scalar, so an i32 result is
        // a boolean that still has to widen to the i64 value channel. An aggregate result is an
        // address and stays one.
        return result && !called?.aggregate && result.ty === WatNodeType.I32 ? watIr.operation("i64.extend_i32_u", result) : result;
    }

    // No member candidate: a non-member operator is an ordinary namespace function, so resolve and
    // call it exactly like one. Only reached once member lookup has missed, so this cannot change how
    // an expression that already resolves is lowered.
    const free = tryLowerFreeOperator(context, operatorName, right ? [left, right] : [left]);

    if (free) {
        return free;
    }

    if (!right) {
        return null;
    }

    // C++20 rewrites `a != b` to `!(a == b)`, so a type declaring equality alone still compares both
    // ways — but only when that operator== returns bool, not merely something convertible to it.
    if (operatorName === "operator!=" && (equalityReturnsBool(context, classOperandName(context, left)) || freeEqualityReturnsBool(context, [left, right]))) {
        const equality = tryLowerOverloadedOperator(context, "operator==", left, right);

        if (equality) {
            return watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", equality));
        }
    }

    return null;
}
