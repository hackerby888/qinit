import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { SCALAR_SIZE, MATH_INTRINSIC_NAMES } from "../abi/tables";
import { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
// True for `auto` (or `auto*`) type specs, which take their real type from the initializer.
export function isAutoType(type: TypeSpec): boolean {
    if (type.kind === "pointer") {
        return isAutoType(type.pointee);
    }
    return type.kind === "name" && type.name === "auto";
}
// Resolve a named type through typedef/using aliases to its underlying spec (bounded walk; stops at a known scalar
export function resolveAliasType(programAnalysis: ProgramAnalysis, type: TypeSpec): TypeSpec {
    let resolvedType = type;
    for (let index = 0; index < 8 && resolvedType.kind === "name" && SCALAR_SIZE[resolvedType.name] === undefined; index++) {
        const typedefType = programAnalysis.typedefs.get(resolvedType.name);
        if (!typedefType || typedefType.kind === "void") {
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
    if (type.kind === "const")
        return unsignedScalar(type.valueType);
    if (type.kind === "reference")
        return unsignedScalar(type.referentType);
    if (type.kind === "pointer")
        return false;
    if (type.kind !== "name")
        return false;
    return (/^(uint|unsigned\b|size_t$|bool$|bit$)/.test(type.name) ||
        type.name === "uint128" ||
        type.name === "uint128_t");
}
// Best-effort signedness is unsigned when unsigned lvalue/params, casts, or suffixed literals are present.
export function isUnsignedExpr(context: FunctionEmissionContext, expression: Expression): boolean {
    switch (expression.kind) {
        case "c_cast":
        case "static_cast":
            return unsignedScalar(expression.type);
        case "paren":
            return isUnsignedExpr(context, expression.expression);
        case "int_literal":
            return /[uU]/.test(expression.suffix ?? "");
        case "identifier": {
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
        case "member_access":
        case "subscript": {
            const type = context.lowering.resolveExpressionAddress(context, expression)?.type ?? null;
            if (type?.kind === "name" && type.name === "DateAndTime")
                return true; // compares via its packed uint64 value
            return type ? unsignedScalar(context.programAnalysis.scalarStorageType(type)) : false;
        }
        case "call": {
            if (expression.callee.kind !== "member_access" ||
                expression.callee.object.kind !== "identifier" ||
                expression.callee.object.name !== "qpi") {
                return false;
            }
            const calleeObjectType = context.lowering.resolveExpressionAddress(context, expression.callee.object)?.type;
            const separator = calleeObjectType?.kind === "name" ? calleeObjectType.name.lastIndexOf("::") : -1;
            const owner = calleeObjectType?.kind === "name"
                ? separator >= 0
                    ? calleeObjectType.name.slice(separator + 2)
                    : calleeObjectType.name
                : calleeObjectType?.kind === "template_instance"
                    ? calleeObjectType.name
                    : null;
            if (!owner)
                return false;
            const method = context.programAnalysis.methodTemplate(owner, calleeObjectType?.kind === "template_instance" ? calleeObjectType.callArguments : [], expression.callee.member, expression.callArguments.length);
            if (!method)
                return false;
            const result = context.programAnalysis.substInBindings(context.programAnalysis.derefType(method.def.returnType), method.bind);
            return context.programAnalysis.isAggregateType(result) || unsignedScalar(context.programAnalysis.scalarStorageType(result));
        }
        case "binary_op":
            if (["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"].includes(expression.operator))
                return isUnsignedExpr(context, expression.left) || isUnsignedExpr(context, expression.right);
            return false;
        case "unary_op":
            if (expression.operator === "-" || expression.operator === "~" || expression.operator === "+")
                return isUnsignedExpr(context, expression.argument);
            return false;
        case "prefix_op":
        case "postfix_op":
            return isUnsignedExpr(context, expression.argument);
        case "ternary":
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
        case "paren":
            return scalarTypeInfo(context, expression.expression);
        case "c_cast":
        case "static_cast": {
            const castTypeName = expression.type?.kind === "name" ? expression.type.name : null;
            const byteWidth = castTypeName ? SCALAR_SIZE[castTypeName] : undefined;
            return byteWidth ? { width: byteWidth, unsigned: unsignedScalar(expression.type) } : null;
        }
        case "int_literal": {
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
        case "identifier":
        case "member_access":
        case "subscript": {
            const type = expression.kind === "identifier"
                ? (context.params?.get(expression.name)?.type ??
                    context.refLocals?.get(expression.name) ??
                    context.localVars.get(expression.name)?.type ??
                    context.programAnalysis.typeOfConstant(expression.name) ??
                    context.lowering.resolveExpressionAddress(context, expression)?.type ??
                    null)
                : (context.lowering.resolveExpressionAddress(context, expression)?.type ?? null);
            let resolvedType = type;
            if (resolvedType?.kind === "const")
                resolvedType = resolvedType.valueType;
            if (resolvedType?.kind === "reference")
                resolvedType = resolvedType.referentType;
            if (resolvedType)
                resolvedType = context.programAnalysis.scalarStorageType(resolvedType);
            const byteWidth = resolvedType?.kind === "name" ? SCALAR_SIZE[resolvedType.name] : undefined;
            return byteWidth
                ? { width: byteWidth, unsigned: unsignedScalar(resolvedType) }
                : null;
        }
        case "binary_op": {
            if (["+", "-", "*", "/", "%", "&", "|", "^"].includes(expression.operator)) {
                const cv = usualConversion(context, expression.left, expression.right);
                return { width: cv.width, unsigned: cv.unsigned };
            }
            if (expression.operator === "<<" || expression.operator === ">>")
                return promoteInfo(context, expression.left);
            // Comparisons and logical ops yield bool, which promotes to int.
            if (["<", ">", "<=", ">=", "==", "!=", "&&", "||"].includes(expression.operator))
                return { width: 4, unsigned: false };
            return null;
        }
        // The C++ common type of the two arms (condition contributes nothing).
        case "ternary": {
            const cv = usualConversion(context, expression.then, expression.else_);
            return { width: cv.width, unsigned: cv.unsigned };
        }
        case "unary_op": {
            if (expression.operator === "-" || expression.operator === "~" || expression.operator === "+")
                return promoteInfo(context, expression.argument);
            if (expression.operator === "!")
                return { width: 4, unsigned: false };
            return null;
        }
        // ++x / x++ yield the operand's own type (no promotion).
        case "prefix_op":
        case "postfix_op":
            return scalarTypeInfo(context, expression.argument);
        case "call":
        case "template_call": {
            // QPI safe-math intrinsics return their (deduced or explicit) argument type; without this a comparison against e.g. `math_lib::max((uint64)a, (uint64)b)`
            const nm = expression.callee?.kind === "identifier" ? expression.callee.name : null;
            if (!nm)
                return null;
            const base = nm.includes("::") ? nm.slice(nm.lastIndexOf("::") + 2) : nm;
            if (!MATH_INTRINSIC_NAMES.has(base)) {
                // A member value helper carries its declared return type; the width/signedness of `pick(x) + 1` etc. follow the
                const set = context.programAnalysis.helperOverloads.get(nm);
                const helper = set?.length
                    ? context.lowering.pickHelperOverload(context, set, expression.callArguments ?? [])
                    : context.programAnalysis.helpers.get(nm);
                const rt = helper?.retType;
                const byteWidth = rt?.kind === "name" ? SCALAR_SIZE[rt.name] : undefined;
                if (byteWidth !== undefined && byteWidth <= 8)
                    return { width: byteWidth, unsigned: unsignedScalar(rt) };
                return null;
            }
            if (expression.kind === "template_call" && expression.templateArguments?.[0]?.kind === "name") {
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
// Integral promotion: sub-int scalars become int (signed, 4 bytes); unknown types fall back to the legacy 64-bit +
export function promoteInfo(context: FunctionEmissionContext, expression: Expression): {
    width: number;
    unsigned: boolean;
} {
    const info = scalarTypeInfo(context, expression) ?? { width: 8, unsigned: isUnsignedExpr(context, expression) };
    if (info.width < 4)
        return { width: 4, unsigned: false };
    return info;
}
// C++ usual arithmetic conversions over the promoted operands: same signedness → wider wins; mixed → unsigned wins at
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
