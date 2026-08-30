import { AstKind, BinaryOp, UnaryOp } from "../shared/enums";
import { SCALAR_SIZE } from "../shared/scalar-sizes";
import { EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec, Expression } from "../ast";
import { parseIntLiteral } from "../frontend/lexer";
import type { ProgramAnalysis } from "./program-analysis";
import { scopedLookupKeys } from "./declaration-index";

export function typeOfConstant(programAnalysis: ProgramAnalysis, name: string): TypeSpec | null {
    return (
        programAnalysis.constexprType.get(name) ??
        programAnalysis.enumConstType.get(name) ??
        (name.includes("::") ? programAnalysis.typeOfConstant(name.slice(name.lastIndexOf("::") + 2)) : null)
    );
}

export function scalarStorageType(programAnalysis: ProgramAnalysis, type: TypeSpec): TypeSpec {
    const dereferencedType = programAnalysis.derefType(type);
    if (dereferencedType.kind !== AstKind.NAME) return dereferencedType;
    const base = dereferencedType.name.includes("::") ? dereferencedType.name.slice(dereferencedType.name.lastIndexOf("::") + 2) : dereferencedType.name;
    const normalized = SCALAR_SIZE[base] !== undefined ? { ...dereferencedType, name: base } : dereferencedType;
    return programAnalysis.enumUnderlying.get(normalized.name) ?? normalized;
}

export function normalizeConst(programAnalysis: ProgramAnalysis, value: bigint, type: TypeSpec): bigint {
    const storageType = programAnalysis.scalarStorageType(type);
    if (storageType.kind !== AstKind.NAME) return value;
    const size = SCALAR_SIZE[storageType.name];
    if (size === undefined || size >= 8) return value;
    if (storageType.name === "bool" || storageType.name === "bit") return value === 0n ? 0n : 1n;
    const bits = BigInt(size * 8);
    const mask = (1n << bits) - 1n;
    const narrowed = value & mask;
    if (/^(sint|signed\b)/.test(storageType.name)) {
        const sign = 1n << (bits - 1n);
        return (narrowed & sign) !== 0n ? narrowed - (1n << bits) : narrowed;
    }
    return narrowed;
}

export function resolveConst(programAnalysis: ProgramAnalysis, name: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint | null {
    const separator = name.lastIndexOf("::");
    if (separator > 0) {
        const qualified = programAnalysis.evalQualifiedConst(name.slice(0, separator), name.slice(separator + 2), templateBindings);
        if (qualified !== null) return qualified;
    }
    const cached = programAnalysis.constCache.get(name);
    if (cached !== undefined) return cached;
    const en = programAnalysis.enumConst.get(name);
    if (en !== undefined) {
        programAnalysis.constCache.set(name, en);
        return en;
    }
    const initializer = programAnalysis.constexprInit.get(name);
    if (initializer === undefined) {
        // Resolve a callee's contract-index constant from its supplied metadata.
        const ci = name.match(/^(\w+)_CONTRACT_INDEX$/);
        if (ci) {
            const candidate = programAnalysis.callees.get(ci[1]);
            if (candidate !== undefined) {
                programAnalysis.constCache.set(name, BigInt(candidate.index));
                return BigInt(candidate.index);
            }
        }
        // A partly-qualified name (Ch::K under `using namespace QPI`) reaches its declaration only once the
        // visible using-directives are applied, so try those before the bare tail they would otherwise hit.
        // Only a candidate that is really declared is followed: recursing on every spelling lets two names
        // that each fall back to the other spin forever.
        for (const candidate of programAnalysis.scopedConstantKeys(name)) {
            if (candidate === name) continue;

            const enumValue = programAnalysis.enumConst.get(candidate);
            if (enumValue !== undefined) return enumValue;

            if (programAnalysis.constexprInit.has(candidate)) {
                return programAnalysis.resolveConst(candidate, templateBindings);
            }
        }
        return null;
    }
    if (programAnalysis.constInProgress.has(name)) return null; // cyclic constexpr — give up
    programAnalysis.constInProgress.add(name);
    try {
        const numericValue = programAnalysis.normalizeConst(
            programAnalysis.evalConstBig(initializer, EMPTY_TEMPLATE_BINDINGS),
            programAnalysis.constexprType.get(name) ?? { kind: AstKind.NAME, name: "sint64" },
        );
        programAnalysis.constCache.set(name, numericValue);
        return numericValue;
    } finally {
        programAnalysis.constInProgress.delete(name);
    }
}

export function evalConst(programAnalysis: ProgramAnalysis, expression: Expression, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    return Number(programAnalysis.evalConstBig(expression, templateBindings));
}

export function tryParseIntLiteral(value: string): bigint {
    try {
        return parseIntLiteral(value);
    } catch {
        return 0n;
    }
}

export function evalConstBig(programAnalysis: ProgramAnalysis, expression: Expression, templateBindings: TemplateBindings): bigint {
    switch (expression.kind) {
        case AstKind.INT_LITERAL:
            return programAnalysis.tryParseIntLiteral(expression.value);
        case AstKind.BOOL_LITERAL:
            return expression.value ? 1n : 0n;
        case AstKind.CHAR_LITERAL:
            return BigInt(expression.value);
        case AstKind.PAREN:
            return programAnalysis.evalConstBig(expression.expression, templateBindings);
        case AstKind.IDENTIFIER: {
            const numericValue = templateBindings.values.get(expression.name);
            if (numericValue !== undefined) return numericValue;
            const resolvedConstant = programAnalysis.resolveConst(expression.name, templateBindings);
            if (resolvedConstant !== null) return resolvedConstant;
            return 0n;
        }
        case AstKind.UNARY_OP: {
            const constantValue = programAnalysis.evalConstBig(expression.argument, templateBindings);
            if (expression.operator === UnaryOp.MINUS) return -constantValue;
            if (expression.operator === UnaryOp.BITWISE_NOT) return ~constantValue;
            if (expression.operator === UnaryOp.LOGICAL_NOT) return constantValue === 0n ? 1n : 0n;
            return constantValue;
        }
        case AstKind.BINARY_OP: {
            const constantValue = programAnalysis.evalConstBig(expression.left, templateBindings);
            const constantValueCandidate = programAnalysis.evalConstBig(expression.right, templateBindings);
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
                case BinaryOp.LOGICAL_AND:
                    return constantValue !== 0n && constantValueCandidate !== 0n ? 1n : 0n;
                case BinaryOp.LOGICAL_OR:
                    return constantValue !== 0n || constantValueCandidate !== 0n ? 1n : 0n;
                default:
                    return 0n;
            }
        }
        case AstKind.TERNARY:
            return programAnalysis.evalConstBig(expression.condition, templateBindings) !== 0n
                ? programAnalysis.evalConstBig(expression.then, templateBindings)
                : programAnalysis.evalConstBig(expression.else_, templateBindings);
        case AstKind.SIZEOF_TYPE:
            return BigInt(programAnalysis.sizeOfType(expression.type, templateBindings));
        case AstKind.SIZEOF_EXPR: {
            // A struct or typedef name parses as an expression, so size it the way the backend does.
            if (expression.expression.kind !== AstKind.IDENTIFIER) return 0n;
            const byteSize = programAnalysis.sizeOfType({ kind: AstKind.NAME, name: expression.expression.name }, templateBindings);
            return BigInt(byteSize);
        }
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
            return programAnalysis.normalizeConst(programAnalysis.evalConstBig(expression.expression, templateBindings), expression.type);
        case AstKind.CALL:
        case AstKind.TEMPLATE_CALL: {
            // QPI safe-math helpers appear in constexpr contexts (e.g. QUTIL_MAX_NEW_POLL = div(MAX_POLL, 4)).
            const callee = expression.callee;
            const fn = callee.kind === AstKind.IDENTIFIER ? callee.name : callee.kind === AstKind.QUALIFIED_NAME ? callee.name : null;
            if (fn) {
                const numericValue = expression.callArguments.map((argument) => programAnalysis.evalConstBig(argument, templateBindings));
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

export function evalConstNum(programAnalysis: ProgramAnalysis, expression: Expression, templateBindings: TemplateBindings): number {
    return Number(programAnalysis.evalConstBig(expression, templateBindings));
}

// Every key a constant reference may be indexed under, using-directives of the translation unit included.
export function scopedConstantKeys(programAnalysis: ProgramAnalysis, name: string): string[] {
    return scopedLookupKeys(name, {
        usingNamespaces: programAnalysis.namespaceUsings.get("") ?? [],
    });
}
