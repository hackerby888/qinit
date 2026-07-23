import { AstKind, BinaryOp, UnaryOp } from "../../../enums";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { SCALAR_SIZE, MATH_INTRINSIC_NAMES } from "../abi/tables";
import { FunctionEmissionContext } from "../types";
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
    if (!type)
        return false;
    if (type.kind === AstKind.CONST)
        return unsignedScalar(type.valueType);
    if (type.kind === AstKind.REFERENCE)
        return unsignedScalar(type.referentType);
    if (type.kind === AstKind.POINTER)
        return false;
    if (type.kind !== AstKind.NAME)
        return false;
    return (/^(uint|unsigned\b|size_t$|bool$|bit$)/.test(type.name) ||
        type.name === "uint128" ||
        type.name === "uint128_t");
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
            if (type)
                return unsignedScalar(context.programAnalysis.scalarStorageType(type.type));
            const rl = context.refLocals?.get(expression.name);
            if (rl)
                return unsignedScalar(context.programAnalysis.scalarStorageType(rl));
            const lv = context.localVars.get(expression.name)?.type;
            if (lv)
                return unsignedScalar(context.programAnalysis.scalarStorageType(lv));
            const constant = context.programAnalysis.typeOfConstant(expression.name);
            if (constant)
                return unsignedScalar(context.programAnalysis.scalarStorageType(constant));
            const addrType = context.lowering.resolveExpressionAddress(context, expression)?.type;
            return addrType ? unsignedScalar(context.programAnalysis.scalarStorageType(addrType)) : false;
        }
        case AstKind.MEMBER_ACCESS:
        case AstKind.SUBSCRIPT: {
            const type = context.lowering.resolveExpressionAddress(context, expression)?.type ?? null;
            if (type?.kind === AstKind.NAME && type.name === "DateAndTime")
                return true; // compares via its packed uint64 value
            return type ? unsignedScalar(context.programAnalysis.scalarStorageType(type)) : false;
        }
        case AstKind.CALL: {
            if (expression.callee.kind !== AstKind.MEMBER_ACCESS ||
                expression.callee.object.kind !== AstKind.IDENTIFIER ||
                expression.callee.object.name !== "qpi") {
                return false;
            }
            const calleeObjectType = context.lowering.resolveExpressionAddress(context, expression.callee.object)?.type;
            const separator = calleeObjectType?.kind === AstKind.NAME ? calleeObjectType.name.lastIndexOf("::") : -1;
            const owner = calleeObjectType?.kind === AstKind.NAME
                ? separator >= 0
                    ? calleeObjectType.name.slice(separator + 2)
                    : calleeObjectType.name
                : calleeObjectType?.kind === AstKind.TEMPLATE_INSTANCE
                    ? calleeObjectType.name
                    : null;
            if (!owner)
                return false;
            const resolvedMethod = context.programAnalysis.resolveSourceMethodDefinition(owner, calleeObjectType?.kind === AstKind.TEMPLATE_INSTANCE ? calleeObjectType.callArguments : [], expression.callee.member, expression.callArguments.length);
            if (!resolvedMethod)
                return false;
            const result = context.programAnalysis.substInBindings(context.programAnalysis.derefType(resolvedMethod.definition.returnType), resolvedMethod.ownerBindings);
            return context.programAnalysis.isAggregateType(result) || unsignedScalar(context.programAnalysis.scalarStorageType(result));
        }
        case AstKind.BINARY_OP:
            if ([
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
            ].includes(expression.operator))
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
// Best-effort (byte width, signedness) of a scalar expression, mirroring isUnsignedExpr's coverage.
export function scalarTypeInfo(context: FunctionEmissionContext, expression: Expression): {
    width: number;
    unsigned: boolean;
} | null {
    switch (expression.kind) {
        case AstKind.PAREN:
            return scalarTypeInfo(context, expression.expression);
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST: {
            const castTypeName = expression.type?.kind === AstKind.NAME ? expression.type.name : null;
            const byteWidth = castTypeName ? SCALAR_SIZE[castTypeName] : undefined;
            return byteWidth ? { width: byteWidth, unsigned: unsignedScalar(expression.type) } : null;
        }
        case AstKind.INT_LITERAL: {
            // C++ literal typing: int → (uint for hex/octal) → long long by fit; a u/U suffix forces unsigned
            const numericValue = context.programAnalysis["sema"].evaluateConstexpr(expression) ?? 0n;
            const suffixU = /[uU]/.test(expression.suffix ?? "");
            const suffixL = /[lL]/.test(expression.suffix ?? "");
            const hex = /^0[xX0-7]/.test(expression.value ?? "");
            if (suffixL)
                return { width: 8, unsigned: suffixU };
            if (numericValue >= -(2n ** 31n) && numericValue < 2n ** 31n)
                return { width: 4, unsigned: suffixU };
            if (suffixU && numericValue < 2n ** 32n)
                return { width: 4, unsigned: true };
            if (hex && numericValue < 2n ** 32n)
                return { width: 4, unsigned: true };
            if (!suffixU && numericValue < 2n ** 63n)
                return { width: 8, unsigned: false };
            return { width: 8, unsigned: true };
        }
        case AstKind.IDENTIFIER:
        case AstKind.MEMBER_ACCESS:
        case AstKind.SUBSCRIPT: {
            const type = expression.kind === AstKind.IDENTIFIER
                ? (context.params?.get(expression.name)?.type ??
                    context.refLocals?.get(expression.name) ??
                    context.localVars.get(expression.name)?.type ??
                    context.programAnalysis.typeOfConstant(expression.name) ??
                    context.lowering.resolveExpressionAddress(context, expression)?.type ??
                    null)
                : (context.lowering.resolveExpressionAddress(context, expression)?.type ?? null);
            let resolvedType = type;
            if (resolvedType?.kind === AstKind.CONST)
                resolvedType = resolvedType.valueType;
            if (resolvedType?.kind === AstKind.REFERENCE)
                resolvedType = resolvedType.referentType;
            if (resolvedType)
                resolvedType = context.programAnalysis.scalarStorageType(resolvedType);
            const byteWidth = resolvedType?.kind === AstKind.NAME ? SCALAR_SIZE[resolvedType.name] : undefined;
            return byteWidth
                ? { width: byteWidth, unsigned: unsignedScalar(resolvedType) }
                : null;
        }
        case AstKind.BINARY_OP: {
            if ([
                BinaryOp.ADD,
                BinaryOp.SUBTRACT,
                BinaryOp.MULTIPLY,
                BinaryOp.DIVIDE,
                BinaryOp.MODULO,
                BinaryOp.BITWISE_AND,
                BinaryOp.BITWISE_OR,
                BinaryOp.BITWISE_XOR,
            ].includes(expression.operator)) {
                const cv = usualConversion(context, expression.left, expression.right);
                return { width: cv.width, unsigned: cv.unsigned };
            }
            if (expression.operator === BinaryOp.SHIFT_LEFT || expression.operator === BinaryOp.SHIFT_RIGHT)
                return promoteInfo(context, expression.left);
            // Comparisons and logical ops yield bool, which promotes to int.
            if ([
                BinaryOp.LESS_THAN,
                BinaryOp.GREATER_THAN,
                BinaryOp.LESS_THAN_OR_EQUAL,
                BinaryOp.GREATER_THAN_OR_EQUAL,
                BinaryOp.EQUAL,
                BinaryOp.NOT_EQUAL,
                BinaryOp.LOGICAL_AND,
                BinaryOp.LOGICAL_OR,
            ].includes(expression.operator))
                return { width: 4, unsigned: false };
            return null;
        }
        // The C++ common type of the two arms (condition contributes nothing).
        case AstKind.TERNARY: {
            const cv = usualConversion(context, expression.then, expression.else_);
            return { width: cv.width, unsigned: cv.unsigned };
        }
        case AstKind.UNARY_OP: {
            if (expression.operator === UnaryOp.MINUS || expression.operator === UnaryOp.BITWISE_NOT || expression.operator === UnaryOp.PLUS)
                return promoteInfo(context, expression.argument);
            if (expression.operator === UnaryOp.LOGICAL_NOT)
                return { width: 4, unsigned: false };
            return null;
        }
        // ++x / x++ yield the operand's own type (no promotion).
        case AstKind.PREFIX_OP:
        case AstKind.POSTFIX_OP:
            return scalarTypeInfo(context, expression.argument);
        case AstKind.CALL:
        case AstKind.TEMPLATE_CALL: {
            // Preserve the deduced scalar type of QPI safe-math calls.
            const nm = expression.callee?.kind === AstKind.IDENTIFIER ? expression.callee.name : null;
            if (!nm)
                return null;
            const base = nm.includes("::") ? nm.slice(nm.lastIndexOf("::") + 2) : nm;
            if (!MATH_INTRINSIC_NAMES.has(base)) {
                // Use a member helper's declared return type for width and signedness.
                const set = context.programAnalysis.helperOverloads.get(nm);
                const helper = set?.length
                    ? context.lowering.pickHelperOverload(context, set, expression.callArguments ?? [])
                    : context.programAnalysis.helpers.get(nm);
                const rt = helper?.retType;
                const byteWidth = rt?.kind === AstKind.NAME ? SCALAR_SIZE[rt.name] : undefined;
                if (byteWidth !== undefined && byteWidth <= 8)
                    return { width: byteWidth, unsigned: unsignedScalar(rt) };
                return null;
            }
            if (expression.kind === AstKind.TEMPLATE_CALL && expression.templateArguments?.[0]?.kind === AstKind.NAME) {
                const byteWidth = SCALAR_SIZE[expression.templateArguments[0].name];
                if (byteWidth)
                    return { width: byteWidth, unsigned: unsignedScalar(expression.templateArguments[0]) };
            }
            const a0 = expression.callArguments?.[0], a1 = expression.callArguments?.[1];
            if (base === "abs")
                return a0 ? promoteInfo(context, a0) : null;
            if (!a0 || !a1)
                return null;
            const cv = usualConversion(context, a0, a1);
            return base === "sdiv" ? { width: cv.width, unsigned: false } : cv;
        }
        default:
            return null;
    }
}
// Apply integral promotion; unknown scalars retain the legacy 64-bit model.
export function promoteInfo(context: FunctionEmissionContext, expression: Expression): {
    width: number;
    unsigned: boolean;
} {
    const info = scalarTypeInfo(context, expression) ?? { width: 8, unsigned: isUnsignedExpr(context, expression) };
    if (info.width < 4)
        return { width: 4, unsigned: false };
    return info;
}
// Apply C++ arithmetic conversions after integral promotion.
export function usualConversion(context: FunctionEmissionContext, left: Expression, right: Expression): {
    width: number;
    unsigned: boolean;
} {
    const leftInfo = promoteInfo(context, left);
    const rightInfo = promoteInfo(context, right);
    const width = Math.max(leftInfo.width, rightInfo.width);
    if (leftInfo.unsigned === rightInfo.unsigned)
        return { width, unsigned: leftInfo.unsigned };
    const unsignedInfo = leftInfo.unsigned ? leftInfo : rightInfo;
    const signedInfo = leftInfo.unsigned ? rightInfo : leftInfo;
    return unsignedInfo.width >= signedInfo.width
        ? { width, unsigned: true }
        : { width, unsigned: false };
}
