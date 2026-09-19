import { AstKind, BinaryOp, UnaryOp } from "../../../shared/enums";
import { ProgramAnalysis } from "../../../semantics/program-analysis";
import { SCALAR_SIZE, MATH_INTRINSIC_NAMES } from "../abi/tables";
import type { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
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
// The declared return type of `object.method(...)`, resolved through the owner's bases and template bindings.
export function memberCallReturnType(context: FunctionEmissionContext, expression: Expression): TypeSpec | null {
    if (expression.kind !== AstKind.CALL || expression.callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const calleeObjectType = context.lowering.resolveExpressionAddress(context, expression.callee.object)?.type;
    const separator = calleeObjectType?.kind === AstKind.NAME ? calleeObjectType.name.lastIndexOf("::") : -1;
    const owner =
        calleeObjectType?.kind === AstKind.NAME
            ? separator >= 0
                ? calleeObjectType.name.slice(separator + 2)
                : calleeObjectType.name
            : calleeObjectType?.kind === AstKind.TEMPLATE_INSTANCE
              ? calleeObjectType.name
              : null;
    if (!owner) return null;
    const resolvedMethod = context.programAnalysis.resolveSourceMethodDefinition(
        owner,
        calleeObjectType?.kind === AstKind.TEMPLATE_INSTANCE ? calleeObjectType.callArguments : [],
        expression.callee.member,
        expression.callArguments.length,
    );
    if (!resolvedMethod) return null;
    return context.programAnalysis.substInBindings(context.programAnalysis.derefType(resolvedMethod.definition.returnType), resolvedMethod.ownerBindings);
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
// What the C++ typing rules cannot decide from the expression alone. A null from `untypedOperand` makes the enclosing expression untyped.
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
            return null;
        }
        // ++x / x++ yield the operand's own type (no promotion).
        case AstKind.PREFIX_OP:
        case AstKind.POSTFIX_OP:
            return scalarInfoOf(expression.argument, leaves);
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
// The outermost expression is not promoted: a comparison stays bool and a ternary over two arms of one type keeps that type.
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
// The scalar type name a declaration or a by-value print gives the expression, or null when any part of it is untyped.
export function valueTypeName(expression: Expression, leaves: ScalarLeaves): string | null {
    const info = valueInfoOf(expression, leaves);
    if (!info) return null;
    if (info.bool) return "bool";
    return SCALAR_NAME_BY_WIDTH[info.width]?.[info.unsigned ? 1 : 0] ?? null;
}
const contextLeavesCache = new WeakMap<FunctionEmissionContext, ScalarLeaves>();
// Emission types every operand: one it cannot resolve keeps the legacy 64-bit model.
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
    const type =
        expression.kind === AstKind.IDENTIFIER
            ? // A class member hides a namespace-scope name of the same spelling, so the
              // addressable lookup runs before named constants — the order the value path uses.
              (context.params?.get(expression.name)?.type ??
              context.refLocals?.get(expression.name) ??
              context.localVars.get(expression.name)?.type ??
              context.lowering.resolveExpressionAddress(context, expression)?.type ??
              // A template parameter is nearer than a namespace-scope constant of the same spelling, so `T` must not resolve to qpi.h's `Ch` constant.
              (context.thisBind?.types.has(expression.name) ? null : context.programAnalysis.typeOfConstant(expression.name)) ??
              null)
            : (context.lowering.resolveExpressionAddress(context, expression)?.type ?? null);
    return type ? scalarStorageInfo(context.programAnalysis, type) : null;
}
// (byte width, signedness) of a declared type once const, reference and aliases are stripped; null for a non-scalar.
export function scalarStorageInfo(programAnalysis: ProgramAnalysis, type: TypeSpec): ScalarInfo | null {
    let resolvedType = type;
    if (resolvedType.kind === AstKind.CONST) resolvedType = resolvedType.valueType;
    if (resolvedType.kind === AstKind.REFERENCE) resolvedType = resolvedType.referentType;
    resolvedType = programAnalysis.scalarStorageType(resolvedType);
    const byteWidth = resolvedType.kind === AstKind.NAME ? SCALAR_SIZE[resolvedType.name] : undefined;
    return byteWidth ? { width: byteWidth, unsigned: unsignedScalar(resolvedType) } : null;
}
// A member helper's declared return type gives the call its width and signedness.
function contextCallInfo(context: FunctionEmissionContext, expression: Expression): ScalarInfo | null {
    if ((expression.kind !== AstKind.CALL && expression.kind !== AstKind.TEMPLATE_CALL) || expression.callee?.kind !== AstKind.IDENTIFIER) return null;
    const nm = expression.callee.name;
    const set = context.programAnalysis.helperOverloads.get(nm);
    const helper = set?.length ? context.lowering.pickHelperOverload(context, set, expression.callArguments ?? []) : context.programAnalysis.helpers.get(nm);
    const rt = helper?.retType;
    const byteWidth = rt?.kind === AstKind.NAME ? SCALAR_SIZE[rt.name] : undefined;
    if (byteWidth !== undefined && byteWidth <= 8) return { width: byteWidth, unsigned: unsignedScalar(rt) };
    return null;
}
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
