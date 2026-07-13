// Sema unit tests: the diagnostics channel's constexpr evaluator (scope-free literal arithmetic).
import { describe, test, expect } from "bun:test";
import { Sema } from "../../src/sema";
import type { Expression, TypeSpec, Span, BinaryOp, UnaryOp } from "../../src/ast";

const NO_SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };

// --- AST helpers for tests ---- Cast through `any` so test builders stay concise while matching the discriminated-union

const n = (name: string): TypeSpec => ({ kind: "name", name, span: NO_SPAN }) as TypeSpec;

const iLit = (value: string): Expression =>
  ({ kind: "int_literal", value, span: NO_SPAN }) as Expression;
const bLit = (value: boolean): Expression =>
  ({ kind: "bool_literal", value, span: NO_SPAN }) as Expression;
const cLit = (value: number): Expression =>
  ({ kind: "char_literal", value, span: NO_SPAN }) as Expression;
const ident = (name: string): Expression =>
  ({ kind: "identifier", name, span: NO_SPAN }) as Expression;
const par = (expr: Expression): Expression =>
  ({ kind: "paren", expr, span: NO_SPAN }) as Expression;
const un = (op: UnaryOp, arg: Expression): Expression =>
  ({ kind: "unary_op", op, arg, span: NO_SPAN }) as Expression;
const bin = (left: Expression, op: BinaryOp, right: Expression): Expression =>
  ({ kind: "binary_op", op, left, right, span: NO_SPAN }) as Expression;
const ter = (cond: Expression, then: Expression, else_: Expression): Expression =>
  ({ kind: "ternary", cond, then, else_, span: NO_SPAN }) as Expression;
const cast = (type: TypeSpec, expr: Expression): Expression =>
  ({ kind: "c_cast", type, expr, span: NO_SPAN }) as Expression;
const callx = (callee: Expression, args: Expression[]): Expression =>
  ({ kind: "call", callee, args, span: NO_SPAN }) as Expression;

const ceval = (sema: Sema, expr: Expression): bigint | null => sema.evaluateConstexpr(expr);

const makeSema = () => new Sema();

// ---- constexpr evaluation ----

describe("Sema — constexpr evaluation", () => {
  // ---- literals ----
  describe("literals", () => {
    test("integer literals", () => {
      const s = makeSema();
      expect(ceval(s, iLit("0"))).toBe(0n);
      expect(ceval(s, iLit("42"))).toBe(42n);
      expect(ceval(s, iLit("0xFF"))).toBe(255n);
      expect(ceval(s, iLit("0b1010"))).toBe(10n);
    });

    test("boolean literals", () => {
      const s = makeSema();
      expect(ceval(s, bLit(true))).toBe(1n);
      expect(ceval(s, bLit(false))).toBe(0n);
    });

    test("char literals", () => {
      const s = makeSema();
      expect(ceval(s, cLit(65))).toBe(65n);
      expect(ceval(s, cLit(0))).toBe(0n);
    });

    test("parenthesized expressions", () => {
      const s = makeSema();
      expect(ceval(s, par(iLit("42")))).toBe(42n);
    });
  });

  // ---- unary operators ----
  describe("unary operators", () => {
    test("logical NOT: !0 = 1, !1 = 0, !42 = 0", () => {
      const s = makeSema();
      expect(ceval(s, un("!", iLit("0")))).toBe(1n);
      expect(ceval(s, un("!", iLit("1")))).toBe(0n);
      expect(ceval(s, un("!", iLit("42")))).toBe(0n);
    });

    test("bitwise NOT: ~0 = -1", () => {
      const s = makeSema();
      expect(ceval(s, un("~", iLit("0")))).toBe(-1n);
      expect(ceval(s, un("~", iLit("0xFF")))).toBe(-256n);
    });

    test("unary minus: -(42) = -42", () => {
      const s = makeSema();
      expect(ceval(s, un("-", iLit("42")))).toBe(-42n);
      expect(ceval(s, un("-", un("-", iLit("5"))))).toBe(5n);
    });

    test("unary plus: +42 = 42", () => {
      const s = makeSema();
      expect(ceval(s, un("+", iLit("42")))).toBe(42n);
    });

    test("pointer deref is rejected at compile time", () => {
      const s = makeSema();
      expect(ceval(s, un("*", ident("p")))).toBeNull();
    });

    test("address-of is rejected at compile time", () => {
      const s = makeSema();
      expect(ceval(s, un("&", ident("x")))).toBeNull();
    });
  });

  // ---- binary operators ----
  describe("binary operators", () => {
    test("arithmetic: + - * / %", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("2"), "+", iLit("3")))).toBe(5n);
      expect(ceval(s, bin(iLit("10"), "-", iLit("3")))).toBe(7n);
      expect(ceval(s, bin(iLit("4"), "*", iLit("5")))).toBe(20n);
      expect(ceval(s, bin(iLit("10"), "/", iLit("3")))).toBe(3n);
      expect(ceval(s, bin(iLit("10"), "%", iLit("3")))).toBe(1n);
    });

    test("division by zero returns 0 (safe math)", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("10"), "/", iLit("0")))).toBe(0n);
      expect(ceval(s, bin(iLit("10"), "%", iLit("0")))).toBe(0n);
    });

    test("shift operators", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("1"), "<<", iLit("4")))).toBe(16n);
      expect(ceval(s, bin(iLit("16"), ">>", iLit("2")))).toBe(4n);
    });

    test("bitwise: & | ^", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("0xFF"), "&", iLit("0x0F")))).toBe(15n);
      expect(ceval(s, bin(iLit("0xF0"), "|", iLit("0x0F")))).toBe(255n);
      expect(ceval(s, bin(iLit("0xFF"), "^", iLit("0x0F")))).toBe(240n);
    });

    test("comparison operators", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("5"), "==", iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("5"), "==", iLit("3")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), "!=", iLit("3")))).toBe(1n);
      expect(ceval(s, bin(iLit("5"), "!=", iLit("5")))).toBe(0n);
      expect(ceval(s, bin(iLit("3"), "<", iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("5"), "<", iLit("3")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), ">", iLit("3")))).toBe(1n);
      expect(ceval(s, bin(iLit("3"), ">", iLit("5")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), "<=", iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("6"), "<=", iLit("5")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), ">=", iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("4"), ">=", iLit("5")))).toBe(0n);
    });

    test("logical operators", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("1"), "&&", iLit("1")))).toBe(1n);
      expect(ceval(s, bin(iLit("1"), "&&", iLit("0")))).toBe(0n);
      expect(ceval(s, bin(iLit("0"), "||", iLit("0")))).toBe(0n);
      expect(ceval(s, bin(iLit("0"), "||", iLit("1")))).toBe(1n);
    });

    test("precedence: 2 + 3 * 4 = 14 (not 20)", () => {
      const s = makeSema();
      const expr = bin(iLit("2"), "+", bin(iLit("3"), "*", iLit("4")));
      expect(ceval(s, expr)).toBe(14n);
    });
  });

  // ---- ternary ----
  describe("ternary", () => {
    test("true ? 1 : 2 → 1", () => {
      const s = makeSema();
      expect(ceval(s, ter(iLit("1"), iLit("1"), iLit("2")))).toBe(1n);
    });

    test("false ? 1 : 2 → 2", () => {
      const s = makeSema();
      expect(ceval(s, ter(iLit("0"), iLit("1"), iLit("2")))).toBe(2n);
    });

    test("ternary with condition expression", () => {
      const s = makeSema();
      const cond = bin(iLit("5"), ">", iLit("3"));
      expect(ceval(s, ter(cond, iLit("10"), iLit("20")))).toBe(10n);
    });
  });

  // ---- casts ----
  describe("casts", () => {
    test("c-style cast evaluates inner expression", () => {
      const s = makeSema();
      expect(ceval(s, cast(n("uint32"), iLit("42")))).toBe(42n);
    });

    test("static_cast evaluates inner expression", () => {
      const s = makeSema();
      const expr: Expression = {
        kind: "static_cast",
        type: n("uint32"),
        expr: iLit("99"),
        span: NO_SPAN,
      } as Expression;
      expect(ceval(s, expr)).toBe(99n);
    });
  });

  // ---- safe math calls ----
  describe("safe math calls in constexpr context", () => {
    test("div(x,y) → x/y", () => {
      const s = makeSema();
      expect(ceval(s, callx(ident("div"), [iLit("10"), iLit("3")]))).toBe(3n);
      expect(ceval(s, callx(ident("div"), [iLit("10"), iLit("0")]))).toBe(0n);
    });

    test("mod(x,y) → x%y", () => {
      const s = makeSema();
      expect(ceval(s, callx(ident("mod"), [iLit("10"), iLit("3")]))).toBe(1n);
      expect(ceval(s, callx(ident("mod"), [iLit("10"), iLit("0")]))).toBe(0n);
    });

    test("min(x,y) → the smaller", () => {
      const s = makeSema();
      expect(ceval(s, callx(ident("min"), [iLit("3"), iLit("7")]))).toBe(3n);
      expect(ceval(s, callx(ident("min"), [iLit("7"), iLit("3")]))).toBe(3n);
    });

    test("max(x,y) → the larger", () => {
      const s = makeSema();
      expect(ceval(s, callx(ident("max"), [iLit("3"), iLit("7")]))).toBe(7n);
      expect(ceval(s, callx(ident("max"), [iLit("7"), iLit("3")]))).toBe(7n);
    });

    test("abs(x) → absolute value", () => {
      const s = makeSema();
      expect(ceval(s, callx(ident("abs"), [iLit("-5")]))).toBe(5n);
      expect(ceval(s, callx(ident("abs"), [iLit("5")]))).toBe(5n);
    });

    test("unknown function in constexpr returns null", () => {
      const s = makeSema();
      expect(ceval(s, callx(ident("unknownFn"), [iLit("1")]))).toBeNull();
    });
  });

  // ---- symbol-dependent expressions yield null ----
  describe("symbol-dependent expressions", () => {
    test("identifiers return null (resolved by codegen's constant table)", () => {
      const s = makeSema();
      expect(ceval(s, ident("UNKNOWN_VAR"))).toBeNull();
    });

    test("sizeof returns null (resolved by codegen's type layout)", () => {
      const s = makeSema();
      const expr: Expression = {
        kind: "sizeof_type",
        type: n("uint64"),
        span: NO_SPAN,
      } as Expression;
      expect(ceval(s, expr)).toBeNull();
    });
  });

  // ---- complex expressions ----
  describe("complex constexpr expressions", () => {
    test("chained operations: ((2+3)*4 - 5)/3 = 5", () => {
      const s = makeSema();
      const expr = bin(
        bin(bin(bin(iLit("2"), "+", iLit("3")), "*", iLit("4")), "-", iLit("5")),
        "/",
        iLit("3"),
      );
      expect(ceval(s, expr)).toBe(5n);
    });

    test("bitwise patterns", () => {
      const s = makeSema();
      const expr = bin(bin(iLit("0xFF"), "&", iLit("0xF0")), ">>", iLit("4"));
      expect(ceval(s, expr)).toBe(15n);
    });

    test("ternary with logical condition", () => {
      const s = makeSema();
      const cond = bin(bin(iLit("5"), ">", iLit("3")), "&&", bin(iLit("2"), "<", iLit("4")));
      expect(ceval(s, ter(cond, iLit("100"), iLit("200")))).toBe(100n);
    });

    test("negated conditional", () => {
      const s = makeSema();
      expect(ceval(s, un("!", bin(iLit("5"), "<", iLit("3"))))).toBe(1n);
    });
  });
});

// ---- diagnostics channel ----

describe("Sema — diagnostics", () => {
  test("error and warning collection", () => {
    const s = makeSema();
    s.error("bad thing", NO_SPAN);
    s.warn("odd thing", NO_SPAN);
    s.warn("placeholder thing", NO_SPAN, "fidelity");

    const d = s.getDiagnostics();
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({ severity: "error", message: "bad thing" });
    expect(d[1]).toMatchObject({ severity: "warning", message: "odd thing" });
    expect(d[2]).toMatchObject({
      severity: "warning",
      message: "placeholder thing",
      category: "fidelity",
    });
  });
});
