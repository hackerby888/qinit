import { AstKind, BinaryOp, UnaryOp } from "../enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, Expression } from "../ast";
import { parseIntLiteral as lexParseIntLiteral } from "../lexer";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function typeOfConstant(context: ProgramAnalysisInternals, name: string): TypeSpec | null {
    return (context.constexprType.get(name) ??
        context.enumConstType.get(name) ??
        (name.includes("::") ? context.typeOfConstant(name.slice(name.lastIndexOf("::") + 2)) : null));
}

export function scalarStorageType(context: ProgramAnalysisInternals, type: TypeSpec): TypeSpec {
    const dereferencedType = context.derefType(type);
    if (dereferencedType.kind !== AstKind.NAME)
        return dereferencedType;
    const base = dereferencedType.name.includes("::") ? dereferencedType.name.slice(dereferencedType.name.lastIndexOf("::") + 2) : dereferencedType.name;
    const normalized = SCALAR_SIZE[base] !== undefined ? { ...dereferencedType, name: base } : dereferencedType;
    return context.enumUnderlying.get(normalized.name) ?? normalized;
}

export function normalizeConst(context: ProgramAnalysisInternals, value: bigint, type: TypeSpec): bigint {
    const storageType = context.scalarStorageType(type);
    if (storageType.kind !== AstKind.NAME)
        return value;
    const size = SCALAR_SIZE[storageType.name];
    if (size === undefined || size >= 8)
        return value;
    if (storageType.name === "bool" || storageType.name === "bit")
        return value === 0n ? 0n : 1n;
    const bits = BigInt(size * 8);
    const mask = (1n << bits) - 1n;
    const narrowed = value & mask;
    if (/^(sint|signed\b)/.test(storageType.name)) {
        const sign = 1n << (bits - 1n);
        return (narrowed & sign) !== 0n ? narrowed - (1n << bits) : narrowed;
    }
    return narrowed;
}

export function resolveConst(
    context: ProgramAnalysisInternals,
    name: string,
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
): bigint | null {
    const separator = name.lastIndexOf("::");
    if (separator > 0) {
        const qualified = context.evalQualifiedConst(
            name.slice(0, separator),
            name.slice(separator + 2),
            templateBindings,
        );
        if (qualified !== null)
            return qualified;
    }
    const cached = context.constCache.get(name);
    if (cached !== undefined)
        return cached;
    const en = context.enumConst.get(name);
    if (en !== undefined) {
        context.constCache.set(name, en);
        return en;
    }
    const initializer = context.constexprInit.get(name);
    if (initializer === undefined) {
        // Resolve a callee's contract-index constant from its supplied metadata.
        const ci = name.match(/^(\w+)_CONTRACT_INDEX$/);
        if (ci) {
            const candidate = context.callees.get(ci[1]);
            if (candidate !== undefined) {
                context.constCache.set(name, BigInt(candidate.index));
                return BigInt(candidate.index);
            }
        }
        // Fall back to the unqualified tail of a namespace constant.
        return separator >= 0 ? context.resolveConst(name.slice(separator + 2), templateBindings) : null;
    }
    if (context.constInProgress.has(name))
        return null; // cyclic constexpr — give up
    context.constInProgress.add(name);
    try {
        const numericValue = context.normalizeConst(context.evalConstBig(initializer, EMPTY_TEMPLATE_BINDINGS), context.constexprType.get(name) ?? { kind: AstKind.NAME, name: "sint64" });
        context.constCache.set(name, numericValue);
        return numericValue;
    }
    finally {
        context.constInProgress.delete(name);
    }
}

export function evalConst(context: ProgramAnalysisInternals, expression: Expression, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    return Number(context.evalConstBig(expression, templateBindings));
}

export function parseIntLiteral(context: ProgramAnalysisInternals, value: string): bigint {
    try {
        return lexParseIntLiteral(value);
    }
    catch {
        return 0n;
    }
}

export function evalConstBig(context: ProgramAnalysisInternals, expression: Expression, templateBindings: TemplateBindings): bigint {
    switch (expression.kind) {
        case AstKind.INT_LITERAL:
            return context.parseIntLiteral(expression.value);
        case AstKind.BOOL_LITERAL:
            return expression.value ? 1n : 0n;
        case AstKind.CHAR_LITERAL:
            return BigInt(expression.value);
        case AstKind.PAREN:
            return context.evalConstBig(expression.expression, templateBindings);
        case AstKind.IDENTIFIER: {
            const numericValue = templateBindings.values.get(expression.name);
            if (numericValue !== undefined)
                return numericValue;
            const resolvedConstant = context.resolveConst(expression.name, templateBindings);
            if (resolvedConstant !== null)
                return resolvedConstant;
            return 0n;
        }
        case AstKind.UNARY_OP: {
            const constantValue = context.evalConstBig(expression.argument, templateBindings);
            if (expression.operator === UnaryOp.MINUS)
                return -constantValue;
            if (expression.operator === UnaryOp.BITWISE_NOT)
                return ~constantValue;
            if (expression.operator === UnaryOp.LOGICAL_NOT)
                return constantValue === 0n ? 1n : 0n;
            return constantValue;
        }
        case AstKind.BINARY_OP: {
            const constantValue = context.evalConstBig(expression.left, templateBindings);
            const constantValueCandidate = context.evalConstBig(expression.right, templateBindings);
            switch (expression.operator) {
                case BinaryOp.ADD:
                    return constantValue + constantValueCandidate;
                case BinaryOp.SUBTRACT:
                    return constantValue - constantValueCandidate;
                case BinaryOp.MULTIPLY:
                    return constantValue * constantValueCandidate;
                case BinaryOp.DIVIDE:
                    return constantValueCandidate === 0n ? 0n : constantValue / constantValueCandidate;
                case BinaryOp.MODULO:
                    return constantValueCandidate === 0n ? 0n : constantValue % constantValueCandidate;
                case BinaryOp.SHIFT_LEFT:
                    return constantValue << constantValueCandidate;
                case BinaryOp.SHIFT_RIGHT:
                    return constantValue >> constantValueCandidate;
                case BinaryOp.BITWISE_AND:
                    return constantValue & constantValueCandidate;
                case BinaryOp.BITWISE_OR:
                    return constantValue | constantValueCandidate;
                case BinaryOp.BITWISE_XOR:
                    return constantValue ^ constantValueCandidate;
                case BinaryOp.LESS_THAN:
                    return constantValue < constantValueCandidate ? 1n : 0n;
                case BinaryOp.GREATER_THAN:
                    return constantValue > constantValueCandidate ? 1n : 0n;
                case BinaryOp.LESS_THAN_OR_EQUAL:
                    return constantValue <= constantValueCandidate ? 1n : 0n;
                case BinaryOp.GREATER_THAN_OR_EQUAL:
                    return constantValue >= constantValueCandidate ? 1n : 0n;
                case BinaryOp.EQUAL:
                    return constantValue === constantValueCandidate ? 1n : 0n;
                case BinaryOp.NOT_EQUAL:
                    return constantValue !== constantValueCandidate ? 1n : 0n;
                default:
                    return 0n;
            }
        }
        case AstKind.TERNARY:
            return context.evalConstBig(expression.condition, templateBindings) !== 0n
                ? context.evalConstBig(expression.then, templateBindings)
                : context.evalConstBig(expression.else_, templateBindings);
        case AstKind.SIZEOF_TYPE:
            return BigInt(context.sizeOfType(expression.type, templateBindings));
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
            return context.normalizeConst(context.evalConstBig(expression.expression, templateBindings), expression.type);
        case AstKind.CALL:
        case AstKind.TEMPLATE_CALL: {
            // QPI safe-math helpers appear in constexpr contexts (e.g. QUTIL_MAX_NEW_POLL = div(MAX_POLL, 4)).
            const callee = expression.callee;
            const fn = callee.kind === AstKind.IDENTIFIER
                ? callee.name
                : callee.kind === AstKind.QUALIFIED_NAME
                    ? callee.name
                    : null;
            if (fn) {
                const numericValue = expression.callArguments.map((argument) => context.evalConstBig(argument, templateBindings));
                switch (fn) {
                    case "div":
                        return numericValue[1] === 0n ? 0n : numericValue[0] / numericValue[1];
                    case "mod":
                        return numericValue[1] === 0n ? 0n : numericValue[0] % numericValue[1];
                    case "min":
                        return numericValue[0] <= numericValue[1] ? numericValue[0] : numericValue[1];
                    case "max":
                        return numericValue[0] >= numericValue[1] ? numericValue[0] : numericValue[1];
                    case "abs":
                        return numericValue[0] < 0n ? -numericValue[0] : numericValue[0];
                }
            }
            return 0n;
        }
        default:
            return 0n;
    }
}

export function evalConstNum(context: ProgramAnalysisInternals, expression: Expression, templateBindings: TemplateBindings): number {
    return Number(context.evalConstBig(expression, templateBindings));
}
