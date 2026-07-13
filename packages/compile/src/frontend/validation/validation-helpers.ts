// Validation runs after parse and before codegen.
import type { FunctionDecl, Expression, TypeSpec } from "../../ast";
import { parseIntLiteral } from "../../lexer";
import { SCALAR_SIZE } from "../../shared/scalar-sizes";

// Strip const/reference wrappers down to the underlying type.
export function unwrapType(type: TypeSpec): TypeSpec {
    if (type.kind === "const") {
        return unwrapType(type.valueType);
    }
    if (type.kind === "reference") {
        return unwrapType(type.referentType);
    }
    return type;
}

export function isVoidType(type: TypeSpec): boolean {
    const unwrappedType = unwrapType(type);
    return unwrappedType.kind === "void" ||
        (unwrappedType.kind === "name" && unwrappedType.name === "void");
}

export function isConstType(type: TypeSpec): boolean {
    if (type.kind === "const") {
        return true;
    }
    if (type.kind === "reference") {
        return type.referentType.kind === "const";
    }
    return false;
}

// Canonical key for a case label / constant operand: numeric literals normalize through BigInt (0x1 and 1 collide),
export function constKey(expression: Expression): string | null {
    if (expression.kind === "int_literal") {
        try {
            return `#${BigInt(expression.value.replace(/[uUlL]+$/, ""))}`;
        }
        catch {
            return `#${expression.value}`;
        }
    }
    if (expression.kind === "char_literal") {
        return `#${expression.value}`;
    }
    if (expression.kind === "bool_literal") {
        return `#${expression.value ? 1 : 0}`;
    }
    if (expression.kind === "unary_op" && expression.operator === "-") {
        const inner = constKey(expression.argument);
        return inner?.startsWith("#") ? `#${-BigInt(inner.slice(1))}` : null;
    }
    if (expression.kind === "identifier") {
        return `id:${expression.name}`;
    }
    if (expression.kind === "qualified_name") {
        return `id:${expression.namespace}::${expression.name}`;
    }
    return null;
}

// True when the literal is integer zero (any radix/suffix).
export function isZeroLiteral(expression: Expression): boolean {
    return constKey(expression) === "#0";
}

export function isLiteral(expression: Expression): boolean {
    return (expression.kind === "int_literal" ||
        expression.kind === "float_literal" ||
        expression.kind === "bool_literal" ||
        expression.kind === "char_literal" ||
        expression.kind === "string_literal");
}

// Small, side-effect-free integral constant evaluator used by validation. Unknown identifiers
export function evalIntegralConst(expression: Expression, resolve?: (name: string) => bigint | null): bigint | null {
    try {
        switch (expression.kind) {
            case "int_literal":
                return parseIntLiteral(expression.value);
            case "bool_literal":
                return expression.value ? 1n : 0n;
            case "char_literal":
                return BigInt(expression.value);
            case "identifier":
                return resolve?.(expression.name) ?? null;
            case "qualified_name":
                return resolve?.(`${expression.namespace}::${expression.name}`) ?? null;
            case "paren":
                return evalIntegralConst(expression.expression, resolve);
            case "unary_op": {
                const numericValue = evalIntegralConst(expression.argument, resolve);
                if (numericValue === null)
                    return null;
                if (expression.operator === "-")
                    return -numericValue;
                if (expression.operator === "+")
                    return numericValue;
                if (expression.operator === "~")
                    return ~numericValue;
                if (expression.operator === "!")
                    return numericValue === 0n ? 1n : 0n;
                return null;
            }
            case "binary_op": {
                const leftValue = evalIntegralConst(expression.left, resolve);
                const rightValue = evalIntegralConst(expression.right, resolve);
                if (leftValue === null || rightValue === null)
                    return null;
                switch (expression.operator) {
                    case "+":
                        return leftValue + rightValue;
                    case "-":
                        return leftValue - rightValue;
                    case "*":
                        return leftValue * rightValue;
                    case "/":
                        return rightValue === 0n ? null : leftValue / rightValue;
                    case "%":
                        return rightValue === 0n ? null : leftValue % rightValue;
                    case "<<":
                        return leftValue << rightValue;
                    case ">>":
                        return leftValue >> rightValue;
                    case "&":
                        return leftValue & rightValue;
                    case "|":
                        return leftValue | rightValue;
                    case "^":
                        return leftValue ^ rightValue;
                    case "==":
                        return leftValue === rightValue ? 1n : 0n;
                    case "!=":
                        return leftValue !== rightValue ? 1n : 0n;
                    case "<":
                        return leftValue < rightValue ? 1n : 0n;
                    case ">":
                        return leftValue > rightValue ? 1n : 0n;
                    case "<=":
                        return leftValue <= rightValue ? 1n : 0n;
                    case ">=":
                        return leftValue >= rightValue ? 1n : 0n;
                    case "&&":
                        return leftValue !== 0n && rightValue !== 0n ? 1n : 0n;
                    case "||":
                        return leftValue !== 0n || rightValue !== 0n ? 1n : 0n;
                    default:
                        return null;
                }
            }
            case "ternary": {
                const numericValue = evalIntegralConst(expression.condition, resolve);
                return numericValue === null ? null : evalIntegralConst(numericValue !== 0n ? expression.then : expression.else_, resolve);
            }
            case "c_cast":
            case "static_cast":
                return evalIntegralConst(expression.expression, resolve);
            case "sizeof_type": {
                const type = unwrapType(expression.type);
                if (type.kind !== "name") {
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
        case "name":
            return type.name;
        case "const":
            return `const ${typeKey(type.valueType)}`;
        case "reference":
            return `${typeKey(type.referentType)}&`;
        case "pointer":
            return `${typeKey(type.pointee)}*`;
        case "template_instance":
            return `${type.name}<${type.callArguments.map(typeKey).join(",")}>`;
        case "array":
            return `${typeKey(type.element)}[]`;
        case "void":
            return "void";
        default:
            return type.kind;
    }
}

export function paramSignature(fn: FunctionDecl): string {
    return fn.params.map((parameter) => typeKey(parameter.type)).join(";");
}
