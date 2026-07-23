import {
    AstKind,
    BinaryOp,
    DiagnosticCategory,
    DiagnosticSeverity,
    UnaryOp,
} from "../enums";
// Sema now owns only diagnostics + constexpr-only arithmetic evaluation.
import type { Span, Expression } from "../ast";

import { parseIntLiteral } from "../lexer";

export interface SemaDiagnostic {
    severity: DiagnosticSeverity.ERROR | DiagnosticSeverity.WARNING;
    message: string;
    span: Span;
    // "fidelity": the construct was lowered to a placeholder instead of faithful code.
    category?: DiagnosticCategory.FIDELITY;
}

export class SemanticAnalysis {
    private diagnostics: SemaDiagnostic[] = [];
    getDiagnostics(): SemaDiagnostic[] {
        return this.diagnostics;
    }
    error(msg: string, span: Span): void {
        this.diagnostics.push({ severity: DiagnosticSeverity.ERROR, message: msg, span });
    }
    warn(msg: string, span: Span, category?: DiagnosticCategory.FIDELITY): void {
        this.diagnostics.push({ severity: DiagnosticSeverity.WARNING, message: msg, span, category });
    }
    // ---- Constexpr evaluation ----
    // Fold literal-only expressions; leave symbol-dependent cases to codegen.
    evaluateConstexpr(expression: Expression): bigint | null {
        try {
            return this.evalExpr(expression);
        }
        catch {
            return null;
        }
    }
    private evalExpr(expression: Expression): bigint {
        switch (expression.kind) {
            case AstKind.INT_LITERAL:
                return parseIntLiteral(expression.value);
            case AstKind.BOOL_LITERAL:
                return BigInt(expression.value ? 1 : 0);
            case AstKind.CHAR_LITERAL:
                return BigInt(expression.value);
            case AstKind.PAREN:
                return this.evalExpr(expression.expression);
            case AstKind.UNARY_OP: {
                const ue = expression as {
                    kind: AstKind.UNARY_OP;
                    operator: UnaryOp;
                    argument: Expression;
                    span: Span;
                };
                const argument = this.evalExpr(ue.argument);
                switch (ue.operator) {
                    case UnaryOp.LOGICAL_NOT:
                        return argument === 0n ? 1n : 0n;
                    case UnaryOp.BITWISE_NOT:
                        return ~argument;
                    case UnaryOp.MINUS:
                        return -argument;
                    case UnaryOp.PLUS:
                        return argument;
                }
                throw new Error(`unknown unary op: ${expression.operator}`);
            }
            case AstKind.BINARY_OP: {
                const left = this.evalExpr(expression.left);
                const right = this.evalExpr(expression.right);
                switch (expression.operator) {
                    case BinaryOp.ADD:
                        return left + right;
                    case BinaryOp.SUBTRACT:
                        return left - right;
                    case BinaryOp.MULTIPLY:
                        return left * right;
                    case BinaryOp.DIVIDE:
                        return right !== 0n ? left / right : 0n;
                    case BinaryOp.MODULO:
                        return right !== 0n ? left % right : 0n;
                    case BinaryOp.SHIFT_LEFT:
                        return left << BigInt(Number(right));
                    case BinaryOp.SHIFT_RIGHT:
                        return left >> BigInt(Number(right));
                    case BinaryOp.BITWISE_AND:
                        return left & right;
                    case BinaryOp.BITWISE_OR:
                        return left | right;
                    case BinaryOp.BITWISE_XOR:
                        return left ^ right;
                    case BinaryOp.EQUAL:
                        return left === right ? 1n : 0n;
                    case BinaryOp.NOT_EQUAL:
                        return left !== right ? 1n : 0n;
                    case BinaryOp.LESS_THAN:
                        return left < right ? 1n : 0n;
                    case BinaryOp.GREATER_THAN:
                        return left > right ? 1n : 0n;
                    case BinaryOp.LESS_THAN_OR_EQUAL:
                        return left <= right ? 1n : 0n;
                    case BinaryOp.GREATER_THAN_OR_EQUAL:
                        return left >= right ? 1n : 0n;
                    case BinaryOp.LOGICAL_AND:
                        return left !== 0n && right !== 0n ? 1n : 0n;
                    case BinaryOp.LOGICAL_OR:
                        return left !== 0n || right !== 0n ? 1n : 0n;
                    default:
                        throw new Error(`unknown binary op: ${expression.operator}`);
                }
            }
            case AstKind.TERNARY:
                return this.evalExpr(expression.condition) !== 0n
                    ? this.evalExpr(expression.then)
                    : this.evalExpr(expression.else_);
            case AstKind.C_CAST:
            case AstKind.STATIC_CAST:
                return this.evalExpr(expression.expression);
            case AstKind.CALL:
            case AstKind.TEMPLATE_CALL: {
                // QPI safe-math helpers used in constexpr contexts, e.g. div<uint32>(REGISTER_AMOUNT, 20).
                const callee = expression.callee;
                const fn = callee.kind === AstKind.IDENTIFIER
                    ? callee.name
                    : callee.kind === AstKind.QUALIFIED_NAME
                        ? (callee as {
                            name: string;
                        }).name
                        : null;
                if (fn) {
                    const numericValue = expression.callArguments.map((argument) => this.evalExpr(argument));
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
                throw new Error(`constexpr eval not supported for call to ${fn ?? "?"}`);
            }
            default:
                throw new Error(`constexpr eval not supported for ${expression.kind}`);
        }
    }
}



export { SemanticAnalysis as Sema };
