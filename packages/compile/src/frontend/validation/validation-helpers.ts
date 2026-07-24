import { AstKind, BinaryOp, UnaryOp } from "../../enums";
// Validation runs after parse and before codegen.
import type { FunctionDecl, Expression, TypeSpec } from "../../ast";
import { parseIntLiteral } from "../../lexer";
import { SCALAR_SIZE } from "../../shared/scalar-sizes";

// Strip const/reference wrappers down to the underlying type.
export function unwrapType(type: TypeSpec): TypeSpec {
    if (type.kind === AstKind.CONST) {
        return unwrapType(type.valueType);
    }
    if (type.kind === AstKind.REFERENCE) {
        return unwrapType(type.referentType);
    }
    return type;
}

export function isVoidType(type: TypeSpec): boolean {
    const unwrappedType = unwrapType(type);
    return unwrappedType.kind === AstKind.VOID ||
        (unwrappedType.kind === AstKind.NAME && unwrappedType.name === "void");
}

export function isConstType(type: TypeSpec): boolean {
    if (type.kind === AstKind.CONST) {
        return true;
    }
    if (type.kind === AstKind.REFERENCE) {
        return type.referentType.kind === AstKind.CONST;
    }
    return false;
}

// Canonicalize case-label constants; numeric spellings compare by value.
export function constKey(expression: Expression): string | null {
    if (expression.kind === AstKind.INT_LITERAL) {
        try {
            return `#${BigInt(expression.value.replace(/[uUlL]+$/, ""))}`;
        }
        catch {
            return `#${expression.value}`;
        }
    }
    if (expression.kind === AstKind.CHAR_LITERAL) {
        return `#${expression.value}`;
    }
    if (expression.kind === AstKind.BOOL_LITERAL) {
        return `#${expression.value ? 1 : 0}`;
    }
    if (expression.kind === AstKind.UNARY_OP && expression.operator === UnaryOp.MINUS) {
        const inner = constKey(expression.argument);
        return inner?.startsWith("#") ? `#${-BigInt(inner.slice(1))}` : null;
    }
    if (expression.kind === AstKind.IDENTIFIER) {
        return `id:${expression.name}`;
    }
    if (expression.kind === AstKind.QUALIFIED_NAME) {
        return `id:${expression.namespace}::${expression.name}`;
    }
    return null;
}

// True when the literal is integer zero (any radix/suffix).
export function isZeroLiteral(expression: Expression): boolean {
    return constKey(expression) === "#0";
}

export function isLiteral(expression: Expression): boolean {
    return (expression.kind === AstKind.INT_LITERAL ||
        expression.kind === AstKind.FLOAT_LITERAL ||
        expression.kind === AstKind.BOOL_LITERAL ||
        expression.kind === AstKind.CHAR_LITERAL ||
        expression.kind === AstKind.STRING_LITERAL);
}

// Evaluate integral constants; unresolved identifiers return null.
export function evalIntegralConst(expression: Expression, resolve?: (name: string) => bigint | null): bigint | null {
    try {
        switch (expression.kind) {
            case AstKind.INT_LITERAL:
                return parseIntLiteral(expression.value);
            case AstKind.BOOL_LITERAL:
                return expression.value ? 1n : 0n;
            case AstKind.CHAR_LITERAL:
                return BigInt(expression.value);
            case AstKind.IDENTIFIER:
                return resolve?.(expression.name) ?? null;
            case AstKind.QUALIFIED_NAME:
                return resolve?.(`${expression.namespace}::${expression.name}`) ?? null;
            case AstKind.PAREN:
                return evalIntegralConst(expression.expression, resolve);
            case AstKind.UNARY_OP: {
                const numericValue = evalIntegralConst(expression.argument, resolve);
                if (numericValue === null)
                    return null;
                if (expression.operator === UnaryOp.MINUS)
                    return -numericValue;
                if (expression.operator === UnaryOp.PLUS)
                    return numericValue;
                if (expression.operator === UnaryOp.BITWISE_NOT)
                    return ~numericValue;
                if (expression.operator === UnaryOp.LOGICAL_NOT)
                    return numericValue === 0n ? 1n : 0n;
                return null;
            }
            case AstKind.BINARY_OP: {
                const leftValue = evalIntegralConst(expression.left, resolve);
                const rightValue = evalIntegralConst(expression.right, resolve);
                if (leftValue === null || rightValue === null)
                    return null;
                switch (expression.operator) {
                    case BinaryOp.ADD:
                        return leftValue + rightValue;
                    case BinaryOp.SUBTRACT:
                        return leftValue - rightValue;
                    case BinaryOp.MULTIPLY:
                        return leftValue * rightValue;
                    case BinaryOp.DIVIDE:
                        return rightValue === 0n ? null : leftValue / rightValue;
                    case BinaryOp.MODULO:
                        return rightValue === 0n ? null : leftValue % rightValue;
                    case BinaryOp.SHIFT_LEFT:
                        return leftValue << rightValue;
                    case BinaryOp.SHIFT_RIGHT:
                        return leftValue >> rightValue;
                    case BinaryOp.BITWISE_AND:
                        return leftValue & rightValue;
                    case BinaryOp.BITWISE_OR:
                        return leftValue | rightValue;
                    case BinaryOp.BITWISE_XOR:
                        return leftValue ^ rightValue;
                    case BinaryOp.EQUAL:
                        return leftValue === rightValue ? 1n : 0n;
                    case BinaryOp.NOT_EQUAL:
                        return leftValue !== rightValue ? 1n : 0n;
                    case BinaryOp.LESS_THAN:
                        return leftValue < rightValue ? 1n : 0n;
                    case BinaryOp.GREATER_THAN:
                        return leftValue > rightValue ? 1n : 0n;
                    case BinaryOp.LESS_THAN_OR_EQUAL:
                        return leftValue <= rightValue ? 1n : 0n;
                    case BinaryOp.GREATER_THAN_OR_EQUAL:
                        return leftValue >= rightValue ? 1n : 0n;
                    case BinaryOp.LOGICAL_AND:
                        return leftValue !== 0n && rightValue !== 0n ? 1n : 0n;
                    case BinaryOp.LOGICAL_OR:
                        return leftValue !== 0n || rightValue !== 0n ? 1n : 0n;
                    default:
                        return null;
                }
            }
            case AstKind.TERNARY: {
                const numericValue = evalIntegralConst(expression.condition, resolve);
                if (numericValue === null)
                    return null;
                const branch = numericValue !== 0n ? expression.then : expression.else_;
                return evalIntegralConst(branch, resolve);
            }
            case AstKind.CALL:
            case AstKind.TEMPLATE_CALL: {
                const callee = expression.callee;
                const name = callee.kind === AstKind.IDENTIFIER ||
                    callee.kind === AstKind.QUALIFIED_NAME
                    ? callee.name
                    : null;
                if (!name)
                    return null;
                const values: bigint[] = [];
                for (const argument of expression.callArguments) {
                    const value = evalIntegralConst(argument, resolve);
                    if (value === null)
                        return null;
                    values.push(value);
                }
                switch (name) {
                    case "div":
                        return values[1] === 0n ? null : values[0] / values[1];
                    case "mod":
                        return values[1] === 0n ? null : values[0] % values[1];
                    case "min":
                        return values[0] <= values[1] ? values[0] : values[1];
                    case "max":
                        return values[0] >= values[1] ? values[0] : values[1];
                    case "abs":
                        return values[0] < 0n ? -values[0] : values[0];
                    default:
                        return null;
                }
            }
            case AstKind.C_CAST:
            case AstKind.STATIC_CAST:
                return evalIntegralConst(expression.expression, resolve);
            case AstKind.SIZEOF_TYPE: {
                const type = unwrapType(expression.type);
                if (type.kind !== AstKind.NAME) {
                    return null;
                }
                const size = SCALAR_SIZE[type.name];
                return size === undefined ? null : BigInt(size);
            }
            default:
                return null;
        }
    }
    catch {
        return null;
    }
}

// Canonical spelling of a type for signature comparison.
export function typeKey(type: TypeSpec): string {
    switch (type.kind) {
        case AstKind.NAME:
            return type.name;
        case AstKind.CONST:
            return `const ${typeKey(type.valueType)}`;
        case AstKind.REFERENCE:
            return `${typeKey(type.referentType)}&`;
        case AstKind.POINTER:
            return `${typeKey(type.pointee)}*`;
        case AstKind.TEMPLATE_INSTANCE:
            return `${type.name}<${type.callArguments.map(typeKey).join(",")}>`;
        case AstKind.ARRAY:
            return `${typeKey(type.element)}[]`;
        case AstKind.VOID:
            return "void";
        default:
            return type.kind;
    }
}

export function paramSignature(fn: FunctionDecl): string {
    return fn.params.map((parameter) => typeKey(parameter.type)).join(";");
}
