// Diagnostics channel + scope-free constexpr folding.
//
// Historically this module owned a symbol table, struct layout, and template instantiation.
// Codegen grew its own bindings-aware versions of all three (resolveType, layoutOfStruct,
// instantiateTemplate) and the pipeline never registered declarations here, so that half was
// unreachable and has been removed. What remains is what the pipeline actually uses: the
// diagnostic sink that codegen reports through, and a literal-arithmetic evaluator.

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

  // Folds expressions built from literals only; anything needing a symbol table (identifiers,
  // sizeof) yields null — codegen resolves those through its own constant table first.
  evaluateConstexpr(expr: Expression): bigint | null {
    try {
      return this.evalExpr(expr);
    } catch {
      return null;
    }
  }

  private evalExpr(expr: Expression): bigint {
    switch (expr.kind) {
      case "int_literal":
        return parseIntLiteral(expr.value);
      case "bool_literal":
        return BigInt(expr.value ? 1 : 0);
      case "char_literal":
        return BigInt(expr.value);
      case "paren":
        return this.evalExpr(expr.expr);
      case "unary_op": {
        const ue = expr as { kind: "unary_op"; op: string; arg: Expression; span: Span };
        const arg = this.evalExpr(ue.arg);
        switch (ue.op) {
          case "!": return arg === 0n ? 1n : 0n;
          case "~": return ~arg;
          case "-": return -arg;
          case "+": return arg;
        }
        throw new Error(`unknown unary op: ${expr.op}`);
      }
      case "binary_op": {
        const left = this.evalExpr(expr.left);
        const right = this.evalExpr(expr.right);
        switch (expr.op) {
          case "+": return left + right;
          case "-": return left - right;
          case "*": return left * right;
          case "/": return right !== 0n ? left / right : 0n;
          case "%": return right !== 0n ? left % right : 0n;
          case "<<": return left << BigInt(Number(right));
          case ">>": return left >> BigInt(Number(right));
          case "&": return left & right;
          case "|": return left | right;
          case "^": return left ^ right;
          case "==": return left === right ? 1n : 0n;
          case "!=": return left !== right ? 1n : 0n;
          case "<": return left < right ? 1n : 0n;
          case ">": return left > right ? 1n : 0n;
          case "<=": return left <= right ? 1n : 0n;
          case ">=": return left >= right ? 1n : 0n;
          case "&&": return (left !== 0n && right !== 0n) ? 1n : 0n;
          case "||": return (left !== 0n || right !== 0n) ? 1n : 0n;
          default: throw new Error(`unknown binary op: ${expr.op}`);
        }
      }
      case "ternary":
        return this.evalExpr(expr.cond) !== 0n ? this.evalExpr(expr.then) : this.evalExpr(expr.else_);
      case "c_cast":
      case "static_cast":
        return this.evalExpr(expr.expr);
      case "call":
      case "template_call": {
        // QPI safe-math helpers used in constexpr contexts, e.g. div<uint32>(REGISTER_AMOUNT, 20).
        // The explicit-type form parses as template_call; both must fold (else derived constants -> 0).
        const c = expr.callee;
        const fn = c.kind === "identifier" ? c.name : c.kind === "qualified_name" ? (c as { name: string }).name : null;
        if (fn) {
          const a = expr.args.map((x) => this.evalExpr(x));
          switch (fn) {
            case "div": return a[1] === 0n ? 0n : a[0] / a[1];
            case "mod": return a[1] === 0n ? 0n : a[0] % a[1];
            case "min": return a[0] <= a[1] ? a[0] : a[1];
            case "max": return a[0] >= a[1] ? a[0] : a[1];
            case "abs": return a[0] < 0n ? -a[0] : a[0];
          }
        }
        throw new Error(`constexpr eval not supported for call to ${fn ?? "?"}`);
      }
      default:
        throw new Error(`constexpr eval not supported for ${expr.kind}`);
    }
  }
}
