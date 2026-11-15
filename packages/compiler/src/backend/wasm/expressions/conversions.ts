import { AstKind, BinaryOp, PlatformPrimitiveKind, PrimitiveResultChannel, UnaryOp } from "../../../shared/enums";
import { ProgramAnalysis } from "../../../semantics/program-analysis";
import { resolvedScalarName } from "../../../semantics/declaration-index";
import { SCALAR_SIZE, MATH_INTRINSIC_NAMES } from "../abi/tables";
import { platformPrimitive } from "../calls/platform-primitives";
import { EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression, FunctionDecl, VariableDecl } from "../../../ast";
// True for `auto` (or `auto*`) type specs, which take their real type from the initializer.
export function isAutoType(type: TypeSpec): boolean {
    if (type.kind === AstKind.POINTER) {
        return isAutoType(type.pointee);
    }
    return type.kind === AstKind.NAME && type.name === "auto";
}
// Resolve named aliases to their underlying types with a bounded walk.
export function resolveAliasType(programAnalysis: ProgramAnalysis, type: TypeSpec): TypeSpec {
    let resolvedType = type;
    for (let index = 0; index < 8 && resolvedType.kind === AstKind.NAME && SCALAR_SIZE[resolvedType.name] === undefined; index++) {
        const typedefType = programAnalysis.typedefs.get(resolvedType.name);
        if (!typedefType || typedefType.kind === AstKind.VOID) {
            break;
        }
        resolvedType = typedefType;
    }
    return resolvedType;
}
// True if a scalar type is unsigned (uint*/unsigned/size_t-like). Drives signed-vs-unsigned op selection.
export function unsignedScalar(type: TypeSpec | null | undefined): boolean {
    if (!type) return false;
    if (type.kind === AstKind.CONST) return unsignedScalar(type.valueType);
    if (type.kind === AstKind.REFERENCE) return unsignedScalar(type.referentType);
    if (type.kind === AstKind.POINTER) return false;
    if (type.kind !== AstKind.NAME) return false;
    return /^(uint|unsigned\b|size_t$|bool$|bit$)/.test(type.name) || type.name === "uint128" || type.name === "uint128_t";
}
// the declared return type of `object.method(...)`, resolved through the owner's bases and template bindings.
export function memberCallReturnType(context: FunctionEmissionContext, expression: Expression): TypeSpec | null {
    if (expression.kind !== AstKind.CALL || expression.callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const calleeObjectType = context.lowering.resolveExpressionAddress(context, expression.callee.object)?.type;
    return methodReturnType(context.programAnalysis, calleeObjectType, expression.callee.member, expression.callArguments.length);
}
// the declared return type of `ownerType::method`, wherever the owner came from: an object, the enclosing class, or a bound template parameter.
export function methodReturnType(programAnalysis: ProgramAnalysis, declaredOwner: TypeSpec | null | undefined, method: string, argumentCount?: number): TypeSpec | null {
    // an owner spelled through a typedef (bit_4096 for a BitArray) is the class the alias names
    const ownerType = declaredOwner ? resolveAliasType(programAnalysis, programAnalysis.derefType(declaredOwner)) : null;
    const separator = ownerType?.kind === AstKind.NAME ? ownerType.name.lastIndexOf("::") : -1;
    const owner =
        ownerType?.kind === AstKind.NAME
            ? separator >= 0
                ? ownerType.name.slice(separator + 2)
                : ownerType.name
            : ownerType?.kind === AstKind.TEMPLATE_INSTANCE
              ? ownerType.name
              : null;
    if (!owner) return null;
    const resolvedMethod = programAnalysis.resolveSourceMethodDefinition(
        owner,
        ownerType?.kind === AstKind.TEMPLATE_INSTANCE ? ownerType.callArguments : [],
        method,
        argumentCount,
    );
    if (resolvedMethod) return programAnalysis.substInBindings(programAnalysis.derefType(resolvedMethod.definition.returnType), resolvedMethod.ownerBindings);
    // a method defined out of line, or bound by the host, still declares its return type in the class or one of its bases
    for (const name of programAnalysis.methodOwnerNames(owner)) {
        const members = programAnalysis.structOf({ kind: AstKind.NAME, name })?.members;
        const declaration = members?.find((candidate) => candidate.kind === AstKind.FUNCTION && (candidate as FunctionDecl).name === method) as FunctionDecl | undefined;
        if (declaration) return programAnalysis.derefType(declaration.returnType);
    }
    return null;
}
// Best-effort signedness is unsigned when unsigned lvalue/params, casts, or suffixed literals are present.
export function isUnsignedExpr(context: FunctionEmissionContext, expression: Expression): boolean {
    switch (expression.kind) {
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
            return unsignedScalar(expression.type);
        case AstKind.PAREN:
            return isUnsignedExpr(context, expression.expression);
        case AstKind.INT_LITERAL:
            return /[uU]/.test(expression.suffix ?? "");
        case AstKind.IDENTIFIER: {
            const type = context.params?.get(expression.name);
            if (type) return unsignedScalar(context.programAnalysis.scalarStorageType(type.type));
            const rl = context.refLocals?.get(expression.name);
            if (rl) return unsignedScalar(context.programAnalysis.scalarStorageType(rl));
            const lv = context.localVars.get(expression.name)?.type;
            if (lv) return unsignedScalar(context.programAnalysis.scalarStorageType(lv));
            const constant = context.programAnalysis.typeOfConstant(expression.name);
            if (constant) return unsignedScalar(context.programAnalysis.scalarStorageType(constant));
            const addrType = context.lowering.resolveExpressionAddress(context, expression)?.type;
            return addrType ? unsignedScalar(context.programAnalysis.scalarStorageType(addrType)) : false;
        }
        case AstKind.MEMBER_ACCESS:
        case AstKind.SUBSCRIPT: {
            const type = context.lowering.resolveExpressionAddress(context, expression)?.type ?? null;
            if (type?.kind === AstKind.NAME && type.name === "DateAndTime") return true; // compares via its packed uint64 value
            return type ? unsignedScalar(context.programAnalysis.scalarStorageType(type)) : false;
        }
        case AstKind.CALL: {
            if (
                expression.callee.kind !== AstKind.MEMBER_ACCESS ||
                expression.callee.object.kind !== AstKind.IDENTIFIER ||
                expression.callee.object.name !== "qpi"
            ) {
                return false;
            }
            const result = memberCallReturnType(context, expression);
            if (!result) return false;
            return context.programAnalysis.isAggregateType(result) || unsignedScalar(context.programAnalysis.scalarStorageType(result));
        }
        case AstKind.BINARY_OP:
            if (
                [
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
                ].includes(expression.operator)
            )
                return isUnsignedExpr(context, expression.left) || isUnsignedExpr(context, expression.right);
            return false;
        case AstKind.UNARY_OP:
            if (expression.operator === UnaryOp.MINUS || expression.operator === UnaryOp.BITWISE_NOT || expression.operator === UnaryOp.PLUS)
                return isUnsignedExpr(context, expression.argument);
            return false;
        case AstKind.PREFIX_OP:
        case AstKind.POSTFIX_OP:
            return isUnsignedExpr(context, expression.argument);
        case AstKind.TERNARY:
            return isUnsignedExpr(context, expression.then) || isUnsignedExpr(context, expression.else_);
        default:
            return false;
    }
}
export interface ScalarInfo {
    width: number;
    unsigned: boolean;
}
// what the C++ typing rules cannot decide from the expression alone. A null from `untypedOperand` makes the enclosing expression untyped.
export interface ScalarLeaves {
    programAnalysis: ProgramAnalysis;
    leafInfo(expression: Expression): ScalarInfo | null;
    callInfo(expression: Expression): ScalarInfo | null;
    untypedOperand(expression: Expression): ScalarInfo | null;
}
const ARITHMETIC_OPERATORS: readonly BinaryOp[] = [
    BinaryOp.ADD,
    BinaryOp.SUBTRACT,
    BinaryOp.MULTIPLY,
    BinaryOp.DIVIDE,
    BinaryOp.MODULO,
    BinaryOp.BITWISE_AND,
    BinaryOp.BITWISE_OR,
    BinaryOp.BITWISE_XOR,
];
const BOOLEAN_OPERATORS: readonly BinaryOp[] = [
    BinaryOp.LESS_THAN,
    BinaryOp.GREATER_THAN,
    BinaryOp.LESS_THAN_OR_EQUAL,
    BinaryOp.GREATER_THAN_OR_EQUAL,
    BinaryOp.EQUAL,
    BinaryOp.NOT_EQUAL,
    BinaryOp.LOGICAL_AND,
    BinaryOp.LOGICAL_OR,
];
// (byte width, signedness) of a scalar expression under the C++ rules, with every name and call resolved through `leaves`.
export function scalarInfoOf(expression: Expression, leaves: ScalarLeaves): ScalarInfo | null {
    switch (expression.kind) {
        case AstKind.PAREN:
            return scalarInfoOf(expression.expression, leaves);
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST: {
            const castTypeName = expression.type?.kind === AstKind.NAME ? expression.type.name : null;
            const byteWidth = castTypeName ? SCALAR_SIZE[castTypeName] : undefined;
            return byteWidth ? { width: byteWidth, unsigned: unsignedScalar(expression.type) } : null;
        }
        case AstKind.INT_LITERAL: {
            // C++ literal typing: int → (uint for hex/octal) → long long by fit; a u/U suffix forces unsigned
            const numericValue = leaves.programAnalysis["sema"].evaluateConstexpr(expression) ?? 0n;
            const suffixU = /[uU]/.test(expression.suffix ?? "");
            const suffixL = /[lL]/.test(expression.suffix ?? "");
            const hex = /^0[xX0-7]/.test(expression.value ?? "");
            if (suffixL) return { width: 8, unsigned: suffixU };
            if (numericValue >= -(2n ** 31n) && numericValue < 2n ** 31n) return { width: 4, unsigned: suffixU };
            if (suffixU && numericValue < 2n ** 32n) return { width: 4, unsigned: true };
            if (hex && numericValue < 2n ** 32n) return { width: 4, unsigned: true };
            if (!suffixU && numericValue < 2n ** 63n) return { width: 8, unsigned: false };
            return { width: 8, unsigned: true };
        }
        case AstKind.IDENTIFIER:
        case AstKind.MEMBER_ACCESS:
        case AstKind.SUBSCRIPT:
            return leaves.leafInfo(expression);
        // size_t as core's 64-bit target has it; the 32-bit size_t of a wasm build is the width rule's concern, not this one's.
        case AstKind.SIZEOF_TYPE:
        case AstKind.SIZEOF_EXPR:
            return { width: 8, unsigned: true };
        case AstKind.BINARY_OP: {
            if (ARITHMETIC_OPERATORS.includes(expression.operator)) return usualConversionOf(expression.left, expression.right, leaves);
            if (expression.operator === BinaryOp.SHIFT_LEFT || expression.operator === BinaryOp.SHIFT_RIGHT) return promoteInfoOf(expression.left, leaves);
            // Comparisons and logical ops yield bool, which promotes to int.
            if (BOOLEAN_OPERATORS.includes(expression.operator)) return { width: 4, unsigned: false };
            return null;
        }
        // The C++ common type of the two arms (condition contributes nothing).
        case AstKind.TERNARY:
            return usualConversionOf(expression.then, expression.else_, leaves);
        case AstKind.UNARY_OP: {
            if (expression.operator === UnaryOp.MINUS || expression.operator === UnaryOp.BITWISE_NOT || expression.operator === UnaryOp.PLUS)
                return promoteInfoOf(expression.argument, leaves);
            if (expression.operator === UnaryOp.LOGICAL_NOT) return { width: 4, unsigned: false };
            // `*p` is an lvalue like any other name: its declared type is the pointee's.
            if (expression.operator === UnaryOp.DEREFERENCE) return leaves.leafInfo(expression);
            return null;
        }
        // ++x / x++ yield the operand's own type (no promotion).
        case AstKind.PREFIX_OP:
        case AstKind.POSTFIX_OP:
            return scalarInfoOf(expression.argument, leaves);
        // an assignment used as a value is its left operand, as in `while ((i = next(i)) >= 0)`.
        case AstKind.ASSIGN:
            return scalarInfoOf(expression.left, leaves);
        case AstKind.CALL:
        case AstKind.TEMPLATE_CALL: {
            // Preserve the deduced scalar type of QPI safe-math calls.
            const nm = expression.callee?.kind === AstKind.IDENTIFIER ? expression.callee.name : null;
            const base = nm ? (nm.includes("::") ? nm.slice(nm.lastIndexOf("::") + 2) : nm) : null;
            if (!base || !MATH_INTRINSIC_NAMES.has(base)) return leaves.callInfo(expression);
            if (expression.kind === AstKind.TEMPLATE_CALL && expression.templateArguments?.[0]?.kind === AstKind.NAME) {
                const byteWidth = SCALAR_SIZE[expression.templateArguments[0].name];
                if (byteWidth)
                    return {
                        width: byteWidth,
                        unsigned: unsignedScalar(expression.templateArguments[0]),
                    };
            }
            const a0 = expression.callArguments?.[0],
                a1 = expression.callArguments?.[1];
            if (base === "abs") return a0 ? promoteInfoOf(a0, leaves) : null;
            if (!a0 || !a1) return null;
            const cv = usualConversionOf(a0, a1, leaves);
            return cv && base === "sdiv" ? { width: cv.width, unsigned: false } : cv;
        }
        default:
            return null;
    }
}
function promoteInfoOf(expression: Expression, leaves: ScalarLeaves): ScalarInfo | null {
    const info = scalarInfoOf(expression, leaves) ?? leaves.untypedOperand(expression);
    if (!info) return null;
    if (info.width < 4) return { width: 4, unsigned: false };
    return info;
}
function usualConversionOf(left: Expression, right: Expression, leaves: ScalarLeaves): ScalarInfo | null {
    const leftInfo = promoteInfoOf(left, leaves);
    const rightInfo = promoteInfoOf(right, leaves);
    if (!leftInfo || !rightInfo) return null;
    const width = Math.max(leftInfo.width, rightInfo.width);
    if (leftInfo.unsigned === rightInfo.unsigned) return { width, unsigned: leftInfo.unsigned };
    const unsignedInfo = leftInfo.unsigned ? leftInfo : rightInfo;
    const signedInfo = leftInfo.unsigned ? rightInfo : leftInfo;
    return unsignedInfo.width >= signedInfo.width ? { width, unsigned: true } : { width, unsigned: false };
}
const SCALAR_NAME_BY_WIDTH: Record<number, [signed: string, unsigned: string]> = {
    1: ["sint8", "uint8"],
    2: ["sint16", "uint16"],
    4: ["sint32", "uint32"],
    8: ["sint64", "uint64"],
};
type ValueInfo = ScalarInfo & { bool?: boolean };
// the outermost expression is not promoted: a comparison stays bool and a ternary over two arms of one type keeps that type.
function valueInfoOf(expression: Expression, leaves: ScalarLeaves): ValueInfo | null {
    switch (expression.kind) {
        case AstKind.PAREN:
            return valueInfoOf(expression.expression, leaves);
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
            if (expression.type?.kind === AstKind.NAME && expression.type.name === "bool") return { width: 1, unsigned: true, bool: true };
            return scalarInfoOf(expression, leaves);
        case AstKind.BINARY_OP:
            return BOOLEAN_OPERATORS.includes(expression.operator) ? { width: 1, unsigned: true, bool: true } : scalarInfoOf(expression, leaves);
        case AstKind.UNARY_OP:
            return expression.operator === UnaryOp.LOGICAL_NOT ? { width: 1, unsigned: true, bool: true } : scalarInfoOf(expression, leaves);
        case AstKind.TERNARY: {
            const thenInfo = valueInfoOf(expression.then, leaves);
            const elseInfo = valueInfoOf(expression.else_, leaves);
            const sameType =
                thenInfo && elseInfo && thenInfo.width === elseInfo.width && thenInfo.unsigned === elseInfo.unsigned && !thenInfo.bool === !elseInfo.bool;
            return sameType ? thenInfo : scalarInfoOf(expression, leaves);
        }
        default:
            return scalarInfoOf(expression, leaves);
    }
}
// the scalar type name a declaration or a by-value print gives the expression, or null when any part of it is untyped.
export function valueTypeName(expression: Expression, leaves: ScalarLeaves): string | null {
    const info = valueInfoOf(expression, leaves);
    if (!info) return null;
    if (info.bool) return "bool";
    return SCALAR_NAME_BY_WIDTH[info.width]?.[info.unsigned ? 1 : 0] ?? null;
}
const contextLeavesCache = new WeakMap<FunctionEmissionContext, ScalarLeaves>();
// emission types every operand: one it cannot resolve keeps the legacy 64-bit model.
export function contextLeaves(context: FunctionEmissionContext): ScalarLeaves {
    let leaves = contextLeavesCache.get(context);
    if (!leaves) {
        leaves = {
            programAnalysis: context.programAnalysis,
            leafInfo: (expression) => contextLeafInfo(context, expression),
            callInfo: (expression) => contextCallInfo(context, expression),
            untypedOperand: (expression) => ({ width: 8, unsigned: isUnsignedExpr(context, expression) }),
        };
        contextLeavesCache.set(context, leaves);
    }
    return leaves;
}
function contextLeafInfo(context: FunctionEmissionContext, expression: Expression): ScalarInfo | null {
    const type = contextLeafType(context, expression);
    if (!type) return null;
    // an element declared through a template parameter (`DataT::Vote votes[N]`) is concrete only under this instance's bindings
    return scalarStorageInfo(context.programAnalysis, context.thisBind ? context.programAnalysis.resolveType(type, context.thisBind) : type);
}
// the declared type a name, member or element resolves to, scalar or not.
function contextLeafType(context: FunctionEmissionContext, expression: Expression): TypeSpec | null {
    return (
        expression.kind === AstKind.IDENTIFIER
            ? // A class member hides a namespace-scope name of the same spelling, so the
              // addressable lookup runs before named constants — the order the value path uses.
              (context.params?.get(expression.name)?.type ??
              context.refLocals?.get(expression.name) ??
              context.localVars.get(expression.name)?.type ??
              context.lowering.resolveExpressionAddress(context, expression)?.type ??
              context.entryTypes?.get(expression.name) ??
              context.thisBind?.valueTypes?.get(expression.name) ??
              staticMemberType(context, context.thisType, expression.name) ??
              // A template parameter is nearer than a namespace-scope constant of the same spelling, so `T` must not resolve to qpi.h's `Ch` constant.
              (context.thisBind?.types.has(expression.name) ? null : context.programAnalysis.typeOfConstant(expression.name)) ??
              // the null pointer constant reads as the literal 0 it expands to
              (expression.name === "NULL" ? INT_TYPE : null))
            : (context.lowering.resolveExpressionAddress(context, expression)?.type ??
              (expression.kind === AstKind.MEMBER_ACCESS ? memberOfValueType(context, expression.object, expression.member) : null))
    );
}
// a member that has no address of its own: a static constant reached through an object, or a limb read straight off a 128-bit result.
function memberOfValueType(context: FunctionEmissionContext, object: Expression, member: string): TypeSpec | null {
    const objectType = context.lowering.resolveExpressionAddress(context, object)?.type;
    if (objectType) return staticMemberType(context, objectType, member);
    return context.lowering.isU128Expr(context, object) ? (context.programAnalysis.fieldOf(UINT128_TYPE, member)?.type ?? null) : null;
}
const UINT128_TYPE: TypeSpec = { kind: AstKind.NAME, name: "uint128_t" };
const INT_TYPE: TypeSpec = { kind: AstKind.NAME, name: "int" };
// a static constexpr member is folded to its value where it is read; its declaration still says how wide that value is.
function staticMemberType(context: FunctionEmissionContext, ownerType: TypeSpec | null | undefined, member: string): TypeSpec | null {
    if (!ownerType) return null;
    const programAnalysis = context.programAnalysis;
    const owner = resolveAliasType(programAnalysis, programAnalysis.derefType(ownerType));
    const ownBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
    const members =
        owner.kind === AstKind.TEMPLATE_INSTANCE ? programAnalysis.templateByName(owner.name)?.members : programAnalysis.structOf(owner, ownBindings)?.members;
    const declaration = members?.find((candidate) => candidate.kind === AstKind.VARIABLE && (candidate as VariableDecl).name === member) as VariableDecl | undefined;
    if (!declaration || !(declaration.isStatic || declaration.isConstexpr)) return null;
    const bindings = owner.kind === AstKind.TEMPLATE_INSTANCE ? programAnalysis.bindContainer(owner.name, owner.callArguments, ownBindings) : ownBindings;
    return programAnalysis.substInBindings(declaration.type, bindings);
}
// (byte width, signedness) of a declared type once const, reference and aliases are stripped; null for a non-scalar.
export function scalarStorageInfo(programAnalysis: ProgramAnalysis, type: TypeSpec): ScalarInfo | null {
    // a typedef such as uint64_t names its scalar only once the alias is followed
    const resolvedType = programAnalysis.scalarStorageType(resolveAliasType(programAnalysis, programAnalysis.derefType(type)));
    const byteWidth = resolvedType.kind === AstKind.NAME ? SCALAR_SIZE[resolvedType.name] : undefined;
    return byteWidth ? { width: byteWidth, unsigned: unsignedScalar(resolvedType) } : null;
}
// a call's declared return type gives it its width and signedness, whether it names a helper or goes through an object.
function contextCallInfo(context: FunctionEmissionContext, expression: Expression): ScalarInfo | null {
    if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.MEMBER_ACCESS) {
        const returned = memberCallReturnType(context, expression);
        const info = returned ? scalarStorageInfo(context.programAnalysis, returned) : null;
        return info && info.width <= 8 ? info : null;
    }
    if ((expression.kind !== AstKind.CALL && expression.kind !== AstKind.TEMPLATE_CALL) || expression.callee?.kind !== AstKind.IDENTIFIER) return null;
    const nm = expression.callee.name;
    const programAnalysis = context.programAnalysis;
    const declared = (type: TypeSpec | null | undefined): ScalarInfo | null => {
        const info = type ? scalarStorageInfo(programAnalysis, type) : null;
        return info && info.width <= 8 ? info : null;
    };
    // `static_cast<T>(x)` with a dependent `T` arrives as a call; the cast names its own type.
    if (expression.kind === AstKind.TEMPLATE_CALL && nm === "static_cast") {
        return declared(programAnalysis.substInBindings(expression.templateArguments[0], context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
    }
    const primitive = platformPrimitive(nm);
    if (primitive?.result === PrimitiveResultChannel.VALUE) {
        // the bit counts and the 128-bit multiply return a 64-bit integer, every other value-returning intrinsic an int
        if (primitive.kind === PlatformPrimitiveKind.WASM_UNARY) return { width: 8, unsigned: true };
        if (primitive.kind === PlatformPrimitiveKind.MULTIPLY_HIGH) return { width: 8, unsigned: !primitive.signed };
        return { width: 4, unsigned: false };
    }
    // inside a class body an unqualified call is a sibling method, and `Param::method` a static of the type bound to that parameter.
    if (context.thisType?.kind === AstKind.TEMPLATE_INSTANCE) {
        const separator = nm.lastIndexOf("::");
        const qualifier = separator >= 0 ? nm.slice(0, separator) : null;
        const owner = qualifier === null || qualifier === context.thisType.name ? context.thisType : context.thisBind?.types.get(qualifier);
        const sibling = declared(methodReturnType(programAnalysis, owner, separator >= 0 ? nm.slice(separator + 2) : nm, expression.callArguments.length));
        if (sibling) return sibling;
    }
    const set = programAnalysis.helperOverloads.get(nm);
    const helper = set?.length ? context.lowering.pickHelperOverload(context, set, expression.callArguments ?? []) : programAnalysis.helpers.get(nm);
    if (helper) return declared(helper.retType);
    // a free function not yet compiled still declares what it returns, as long as its overloads agree
    for (const key of programAnalysis.namespaceCandidates(nm, context.sourceNamespace, context.usingNamespaces)) {
        const definitions = programAnalysis.libFnOverloads.get(key);
        if (definitions?.length) {
            const first = declared(definitions[0].returnType);
            return first && definitions.every((definition) => sameScalar(declared(definition.returnType), first)) ? first : null;
        }
    }
    // `Owner::method(...)` outside any class body is a static of the struct it names
    const scope = nm.lastIndexOf("::");
    if (scope > 0) {
        const qualifier = nm.slice(0, scope);
        const owner = context.thisBind?.types.get(qualifier) ?? ({ kind: AstKind.NAME, name: qualifier } as TypeSpec);
        const result = declared(methodReturnType(programAnalysis, owner, nm.slice(scope + 2), expression.callArguments.length));
        if (result) return result;
    }
    // a functional cast names a scalar directly, through an alias, or through a bound template parameter
    if (expression.callArguments.length === 1) {
        const bound = context.thisBind?.types.get(nm);
        const scalarName = resolvedScalarName(programAnalysis, bound?.kind === AstKind.NAME ? bound.name : nm);
        if (SCALAR_SIZE[scalarName] !== undefined) return declared({ kind: AstKind.NAME, name: scalarName });
    }
    return null;
}
const sameScalar = (left: ScalarInfo | null, right: ScalarInfo): boolean => left?.width === right.width && left.unsigned === right.unsigned;
// Best-effort (byte width, signedness) of a scalar expression, mirroring isUnsignedExpr's coverage.
export function scalarTypeInfo(context: FunctionEmissionContext, expression: Expression): ScalarInfo | null {
    return scalarInfoOf(expression, contextLeaves(context));
}
// Apply integral promotion; unknown scalars retain the legacy 64-bit model.
export function promoteInfo(context: FunctionEmissionContext, expression: Expression): ScalarInfo {
    return promoteInfoOf(expression, contextLeaves(context)) ?? { width: 8, unsigned: isUnsignedExpr(context, expression) };
}
// Apply C++ arithmetic conversions after integral promotion.
export function usualConversion(context: FunctionEmissionContext, left: Expression, right: Expression): ScalarInfo {
    return usualConversionOf(left, right, contextLeaves(context)) ?? { width: 8, unsigned: isUnsignedExpr(context, left) || isUnsignedExpr(context, right) };
}
