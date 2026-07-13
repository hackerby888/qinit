// Sema now owns only diagnostics + constexpr-only arithmetic evaluation.

import type { Span, Expression } from "./ast";
import { parseIntLiteral } from "./lexer";

export interface SemaDiagnostic {
  severity: "error" | "warning";
  message: string;
  span: Span;
  // "fidelity": the construct was lowered to a placeholder instead of faithful code.
  category?: "fidelity";
}

export class Sema {
  private diagnostics: SemaDiagnostic[] = [];

  getDiagnostics(): SemaDiagnostic[] {
    return this.diagnostics;
  }

  error(msg: string, span: Span): void {
    this.diagnostics.push({ severity: "error", message: msg, span });
  }

  warn(msg: string, span: Span, category?: "fidelity"): void {
    this.diagnostics.push({ severity: "warning", message: msg, span, category });
  }

  // ---- Constexpr evaluation ----

  // Folds expressions built from literals only; anything needing a symbol table (identifiers, sizeof) yields null — codegen resolves
  evaluateConstexpr(expression: Expression): bigint | null {
    try {
      return this.evalExpr(expression);
    } catch {
      return null;
    }
  }

  private evalExpr(expression: Expression): bigint {
    switch (expression.kind) {
      case "int_literal":
        return parseIntLiteral(expression.value);
      case "bool_literal":
        return BigInt(expression.value ? 1 : 0);
      case "char_literal":
        return BigInt(expression.value);
      case "paren":
        return this.evalExpr(expression.expression);
      case "unary_op": {
        const ue = expression as { kind: "unary_op"; operator: string; argument: Expression; span: Span };
        const argument = this.evalExpr(ue.argument);
        switch (ue.operator) {
          case "!":
            return argument === 0n ? 1n : 0n;
          case "~":
            return ~argument;
          case "-":
            return -argument;
          case "+":
            return argument;
        }
        throw new Error(`unknown unary op: ${expression.operator}`);
      }
      case "binary_op": {
        const left = this.evalExpr(expression.left);
        const right = this.evalExpr(expression.right);
        switch (expression.operator) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return right !== 0n ? left / right : 0n;
          case "%":
            return right !== 0n ? left % right : 0n;
          case "<<":
            return left << BigInt(Number(right));
          case ">>":
            return left >> BigInt(Number(right));
          case "&":
            return left & right;
          case "|":
            return left | right;
          case "^":
            return left ^ right;
          case "==":
            return left === right ? 1n : 0n;
          case "!=":
            return left !== right ? 1n : 0n;
          case "<":
            return left < right ? 1n : 0n;
          case ">":
            return left > right ? 1n : 0n;
          case "<=":
            return left <= right ? 1n : 0n;
          case ">=":
            return left >= right ? 1n : 0n;
          case "&&":
            return left !== 0n && right !== 0n ? 1n : 0n;
          case "||":
            return left !== 0n || right !== 0n ? 1n : 0n;
          default:
            throw new Error(`unknown binary op: ${expression.operator}`);
        }
      }
      case "ternary":
        return this.evalExpr(expression.condition) !== 0n
          ? this.evalExpr(expression.then)
          : this.evalExpr(expression.else_);
      case "c_cast":
      case "static_cast":
        return this.evalExpr(expression.expression);
      case "call":
      case "template_call": {
        // QPI safe-math helpers used in constexpr contexts, e.g. div<uint32>(REGISTER_AMOUNT, 20).
        const callee = expression.callee;
        const fn =
          callee.kind === "identifier"
            ? callee.name
            : callee.kind === "qualified_name"
              ? (callee as { name: string }).name
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
