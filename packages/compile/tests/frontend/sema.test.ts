import {
  AstKind,
  BinaryOp,
  DiagnosticCategory,
  DiagnosticSeverity,
  UnaryOp,
} from "../../src/enums";
// Sema unit tests: the diagnostics channel's constexpr evaluator (scope-free literal arithmetic).
import { describe, test, expect } from "bun:test";
import { Sema } from "../../src/sema";
import type { Expression, TypeSpec, Span } from "../../src/ast";

const NO_SPAN: Span = { start: 0, end: 0, line: 1, column: 1 };

// AST helpers use `any` to keep valid test objects concise.

const n = (name: string): TypeSpec => ({ kind: AstKind.NAME, name, span: NO_SPAN }) as TypeSpec;

const iLit = (value: string): Expression =>
  ({ kind: AstKind.INT_LITERAL, value, span: NO_SPAN }) as Expression;
const bLit = (value: boolean): Expression =>
  ({ kind: AstKind.BOOL_LITERAL, value, span: NO_SPAN }) as Expression;
const cLit = (value: number): Expression =>
  ({ kind: AstKind.CHAR_LITERAL, value, span: NO_SPAN }) as Expression;
const ident = (name: string): Expression =>
  ({ kind: AstKind.IDENTIFIER, name, span: NO_SPAN }) as Expression;
const par = (expression: Expression): Expression =>
  ({ kind: AstKind.PAREN, expression, span: NO_SPAN }) as Expression;
const un = (operator: UnaryOp, argument: Expression): Expression =>
  ({ kind: AstKind.UNARY_OP, operator, argument, span: NO_SPAN }) as Expression;
const bin = (left: Expression, operator: BinaryOp, right: Expression): Expression =>
  ({ kind: AstKind.BINARY_OP, operator, left, right, span: NO_SPAN }) as Expression;
const ter = (condition: Expression, then: Expression, else_: Expression): Expression =>
  ({ kind: AstKind.TERNARY, condition, then, else_, span: NO_SPAN }) as Expression;
const cast = (type: TypeSpec, expression: Expression): Expression =>
  ({ kind: AstKind.C_CAST, type, expression, span: NO_SPAN }) as Expression;
const callx = (callee: Expression, callArguments: Expression[]): Expression =>
  ({ kind: AstKind.CALL, callee, callArguments, span: NO_SPAN }) as Expression;

const ceval = (sema: Sema, expression: Expression): bigint | null => sema.evaluateConstexpr(expression);

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
      expect(ceval(s, un(UnaryOp.LOGICAL_NOT, iLit("0")))).toBe(1n);
      expect(ceval(s, un(UnaryOp.LOGICAL_NOT, iLit("1")))).toBe(0n);
      expect(ceval(s, un(UnaryOp.LOGICAL_NOT, iLit("42")))).toBe(0n);
    });

    test("bitwise NOT: ~0 = -1", () => {
      const s = makeSema();
      expect(ceval(s, un(UnaryOp.BITWISE_NOT, iLit("0")))).toBe(-1n);
      expect(ceval(s, un(UnaryOp.BITWISE_NOT, iLit("0xFF")))).toBe(-256n);
    });

    test("unary minus: -(42) = -42", () => {
      const s = makeSema();
      expect(ceval(s, un(UnaryOp.MINUS, iLit("42")))).toBe(-42n);
      expect(ceval(s, un(UnaryOp.MINUS, un(UnaryOp.MINUS, iLit("5"))))).toBe(5n);
    });

    test("unary plus: +42 = 42", () => {
      const s = makeSema();
      expect(ceval(s, un(UnaryOp.PLUS, iLit("42")))).toBe(42n);
    });

    test("pointer deref is rejected at compile time", () => {
      const s = makeSema();
      expect(ceval(s, un(UnaryOp.DEREFERENCE, ident("p")))).toBeNull();
    });

    test("address-of is rejected at compile time", () => {
      const s = makeSema();
      expect(ceval(s, un(UnaryOp.ADDRESS_OF, ident("x")))).toBeNull();
    });
  });

  // ---- binary operators ----
  describe("binary operators", () => {
    test("arithmetic: + - * / %", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("2"), BinaryOp.ADD, iLit("3")))).toBe(5n);
      expect(ceval(s, bin(iLit("10"), BinaryOp.SUBTRACT, iLit("3")))).toBe(7n);
      expect(ceval(s, bin(iLit("4"), BinaryOp.MULTIPLY, iLit("5")))).toBe(20n);
      expect(ceval(s, bin(iLit("10"), BinaryOp.DIVIDE, iLit("3")))).toBe(3n);
      expect(ceval(s, bin(iLit("10"), BinaryOp.MODULO, iLit("3")))).toBe(1n);
    });

    test("division by zero returns 0 (safe math)", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("10"), BinaryOp.DIVIDE, iLit("0")))).toBe(0n);
      expect(ceval(s, bin(iLit("10"), BinaryOp.MODULO, iLit("0")))).toBe(0n);
    });

    test("shift operators", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("1"), BinaryOp.SHIFT_LEFT, iLit("4")))).toBe(16n);
      expect(ceval(s, bin(iLit("16"), BinaryOp.SHIFT_RIGHT, iLit("2")))).toBe(4n);
    });

    test("bitwise: & | ^", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("0xFF"), BinaryOp.BITWISE_AND, iLit("0x0F")))).toBe(15n);
      expect(ceval(s, bin(iLit("0xF0"), BinaryOp.BITWISE_OR, iLit("0x0F")))).toBe(255n);
      expect(ceval(s, bin(iLit("0xFF"), BinaryOp.BITWISE_XOR, iLit("0x0F")))).toBe(240n);
    });

    test("comparison operators", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("5"), BinaryOp.EQUAL, iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.EQUAL, iLit("3")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.NOT_EQUAL, iLit("3")))).toBe(1n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.NOT_EQUAL, iLit("5")))).toBe(0n);
      expect(ceval(s, bin(iLit("3"), BinaryOp.LESS_THAN, iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.LESS_THAN, iLit("3")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.GREATER_THAN, iLit("3")))).toBe(1n);
      expect(ceval(s, bin(iLit("3"), BinaryOp.GREATER_THAN, iLit("5")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.LESS_THAN_OR_EQUAL, iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("6"), BinaryOp.LESS_THAN_OR_EQUAL, iLit("5")))).toBe(0n);
      expect(ceval(s, bin(iLit("5"), BinaryOp.GREATER_THAN_OR_EQUAL, iLit("5")))).toBe(1n);
      expect(ceval(s, bin(iLit("4"), BinaryOp.GREATER_THAN_OR_EQUAL, iLit("5")))).toBe(0n);
    });

    test("logical operators", () => {
      const s = makeSema();
      expect(ceval(s, bin(iLit("1"), BinaryOp.LOGICAL_AND, iLit("1")))).toBe(1n);
      expect(ceval(s, bin(iLit("1"), BinaryOp.LOGICAL_AND, iLit("0")))).toBe(0n);
      expect(ceval(s, bin(iLit("0"), BinaryOp.LOGICAL_OR, iLit("0")))).toBe(0n);
      expect(ceval(s, bin(iLit("0"), BinaryOp.LOGICAL_OR, iLit("1")))).toBe(1n);
    });

    test("precedence: 2 + 3 * 4 = 14 (not 20)", () => {
      const s = makeSema();
      const expression = bin(iLit("2"), BinaryOp.ADD, bin(iLit("3"), BinaryOp.MULTIPLY, iLit("4")));
      expect(ceval(s, expression)).toBe(14n);
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
      const condition = bin(iLit("5"), BinaryOp.GREATER_THAN, iLit("3"));
      expect(ceval(s, ter(condition, iLit("10"), iLit("20")))).toBe(10n);
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
      const expression: Expression = {
        kind: AstKind.STATIC_CAST,
        type: n("uint32"),
        expression: iLit("99"),
        span: NO_SPAN,
      } as Expression;
      expect(ceval(s, expression)).toBe(99n);
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
      const expression: Expression = {
        kind: AstKind.SIZEOF_TYPE,
        type: n("uint64"),
        span: NO_SPAN,
      } as Expression;
      expect(ceval(s, expression)).toBeNull();
    });
  });

  // ---- complex expressions ----
  describe("complex constexpr expressions", () => {
    test("chained operations: ((2+3)*4 - 5)/3 = 5", () => {
      const s = makeSema();
      const expression = bin(
        bin(bin(bin(iLit("2"), BinaryOp.ADD, iLit("3")), BinaryOp.MULTIPLY, iLit("4")), BinaryOp.SUBTRACT, iLit("5")),
        BinaryOp.DIVIDE,
        iLit("3"),
      );
      expect(ceval(s, expression)).toBe(5n);
    });

    test("bitwise patterns", () => {
      const s = makeSema();
      const expression = bin(bin(iLit("0xFF"), BinaryOp.BITWISE_AND, iLit("0xF0")), BinaryOp.SHIFT_RIGHT, iLit("4"));
      expect(ceval(s, expression)).toBe(15n);
    });

    test("ternary with logical condition", () => {
      const s = makeSema();
      const condition = bin(bin(iLit("5"), BinaryOp.GREATER_THAN, iLit("3")), BinaryOp.LOGICAL_AND, bin(iLit("2"), BinaryOp.LESS_THAN, iLit("4")));
      expect(ceval(s, ter(condition, iLit("100"), iLit("200")))).toBe(100n);
    });

    test("negated conditional", () => {
      const s = makeSema();
      expect(ceval(s, un(UnaryOp.LOGICAL_NOT, bin(iLit("5"), BinaryOp.LESS_THAN, iLit("3"))))).toBe(1n);
    });
  });
});

// ---- diagnostics channel ----

describe("Sema — diagnostics", () => {
  test("error and warning collection", () => {
    const s = makeSema();
    s.error("bad thing", NO_SPAN);
    s.warn("odd thing", NO_SPAN);
    s.warn("placeholder thing", NO_SPAN, DiagnosticCategory.FIDELITY);

    const d = s.getDiagnostics();
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({
      severity: DiagnosticSeverity.ERROR,
      message: "bad thing",
    });
    expect(d[1]).toMatchObject({
      severity: DiagnosticSeverity.WARNING,
      message: "odd thing",
    });
    expect(d[2]).toMatchObject({
      severity: DiagnosticSeverity.WARNING,
      message: "placeholder thing",
      category: DiagnosticCategory.FIDELITY,
    });
  });
});
