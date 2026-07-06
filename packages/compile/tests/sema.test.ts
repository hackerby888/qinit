// Sema unit tests: constexpr evaluation, type resolution, struct layout, template instantiation.
import { describe, test, expect } from "bun:test";
import { Sema } from "../src/sema";
import type {
  Expression, TypeSpec, Declaration, StructDecl,
  ClassTemplateDecl, Span, BinaryOp, UnaryOp, VariableDecl, TemplateParam,
} from "../src/ast";

const NO_SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };

// ---- AST helpers for tests ----
// Cast through `any` so test builders stay concise while matching the discriminated-union
// types at the construction site. Every helper produces objects whose runtime shape the
// compiler stages accept; the casts just silence the literal-excess-property checks.

const n = (name: string): TypeSpec => ({ kind: "name", name, span: NO_SPAN } as TypeSpec);
const ptr = (pointee: TypeSpec): TypeSpec => ({ kind: "pointer", pointee, span: NO_SPAN } as TypeSpec);
const cnst = (inner: TypeSpec): TypeSpec => ({ kind: "const", valueType: inner, span: NO_SPAN } as TypeSpec);
const vd = (): TypeSpec => ({ kind: "void", span: NO_SPAN } as TypeSpec);
const arr = (elem: TypeSpec, size: Expression): TypeSpec => ({ kind: "array", elem, size, span: NO_SPAN } as TypeSpec);

const iLit = (value: string): Expression => ({ kind: "int_literal", value, span: NO_SPAN } as Expression);
const bLit = (value: boolean): Expression => ({ kind: "bool_literal", value, span: NO_SPAN } as Expression);
const cLit = (value: number): Expression => ({ kind: "char_literal", value, span: NO_SPAN } as Expression);
const ident = (name: string): Expression => ({ kind: "identifier", name, span: NO_SPAN } as Expression);
const par = (expr: Expression): Expression => ({ kind: "paren", expr, span: NO_SPAN } as Expression);
const un = (op: UnaryOp, arg: Expression): Expression => ({ kind: "unary_op", op, arg, span: NO_SPAN } as Expression);
const bin = (left: Expression, op: BinaryOp, right: Expression): Expression => ({ kind: "binary_op", op, left, right, span: NO_SPAN } as Expression);
const ter = (cond: Expression, then: Expression, else_: Expression): Expression => ({ kind: "ternary", cond, then, else_, span: NO_SPAN } as Expression);
const sz = (type: TypeSpec): Expression => ({ kind: "sizeof_type", type, span: NO_SPAN } as Expression);
const cast = (type: TypeSpec, expr: Expression): Expression => ({ kind: "c_cast", type, expr, span: NO_SPAN } as Expression);
const callx = (callee: Expression, args: Expression[]): Expression => ({ kind: "call", callee, args, span: NO_SPAN } as Expression);

const fld = (name: string, type: TypeSpec, access: "public" | "protected" | "private" = "public"): VariableDecl =>
  ({ kind: "variable", name, type, isConstexpr: false, isStatic: false, isExtern: false, isMember: true, access, span: NO_SPAN } as VariableDecl);

const sdecl = (name: string, members: Declaration[], bases: TypeSpec[] = []): StructDecl =>
  ({ kind: "struct", name, members, bases, span: NO_SPAN } as StructDecl);

const tdecl = (name: string, params: TemplateParam[], members: Declaration[]): ClassTemplateDecl =>
  ({ kind: "class_template", name, params, members, bases: [], span: NO_SPAN } as ClassTemplateDecl);

// Access evaluateConstexpr via (sema as any).evaluateConstexpr
const ceval = (sema: Sema, expr: Expression): bigint | null =>
  (sema as any).evaluateConstexpr(expr) as bigint | null;

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

  // ---- sizeof ----
  describe("sizeof", () => {
    test("sizeof builtin types", () => {
      const s = makeSema();
      expect(ceval(s, sz(n("uint8")))).toBe(1n);
      expect(ceval(s, sz(n("uint16")))).toBe(2n);
      expect(ceval(s, sz(n("uint32")))).toBe(4n);
      expect(ceval(s, sz(n("uint64")))).toBe(8n);
      expect(ceval(s, sz(n("uint128")))).toBe(16n);
      expect(ceval(s, sz(n("id")))).toBe(32n);
      expect(ceval(s, sz(n("bool")))).toBe(1n);
      expect(ceval(s, sz(n("void")))).toBe(0n);
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
      const expr: Expression = { kind: "static_cast", type: n("uint32"), expr: iLit("99"), span: NO_SPAN } as Expression;
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

  // ---- constexpr variable lookup ----
  describe("constexpr variable lookup", () => {
    test("enum constants are resolvable", () => {
      const s = new Sema();
      const enumDecl: Declaration = {
        kind: "enum",
        name: "Color",
        isClass: false,
        members: [
          { name: "RED", value: iLit("0"), span: NO_SPAN },
          { name: "GREEN", value: iLit("1"), span: NO_SPAN },
        ],
        span: NO_SPAN,
      } as Declaration;
      (s as any).registerDecl(enumDecl, (s as any)._globalScope);

      expect(ceval(s, ident("RED"))).toBe(0n);
      expect(ceval(s, ident("GREEN"))).toBe(1n);
    });

    test("unknown identifier returns null", () => {
      const s = makeSema();
      expect(ceval(s, ident("UNKNOWN_VAR"))).toBeNull();
    });
  });

  // ---- complex expressions ----
  describe("complex constexpr expressions", () => {
    test("chained operations: ((2+3)*4 - 5)/3 = 5", () => {
      const s = makeSema();
      const expr = bin(
        bin(
          bin(bin(iLit("2"), "+", iLit("3")), "*", iLit("4")),
          "-",
          iLit("5"),
        ),
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
      const cond = bin(
        bin(iLit("5"), ">", iLit("3")),
        "&&",
        bin(iLit("2"), "<", iLit("4")),
      );
      expect(ceval(s, ter(cond, iLit("100"), iLit("200")))).toBe(100n);
    });

    test("negated conditional", () => {
      const s = makeSema();
      expect(ceval(s, un("!", bin(iLit("5"), "<", iLit("3"))))).toBe(1n);
    });
  });
});

// ---- type resolution ----

describe("Sema — type resolution", () => {
  test("builtin types resolve to correct sizes", () => {
    const s = new Sema();
    expect((s as any).resolveType(n("uint64"))?.size).toBe(8);
    expect((s as any).resolveType(n("uint32"))?.size).toBe(4);
    expect((s as any).resolveType(n("uint8"))?.size).toBe(1);
    expect((s as any).resolveType(n("sint64"))?.size).toBe(8);
    expect((s as any).resolveType(n("bool"))?.size).toBe(1);
    expect((s as any).resolveType(n("void"))?.size).toBe(0);
    expect((s as any).resolveType(n("uint128"))?.size).toBe(16);
    expect((s as any).resolveType(n("id"))?.size).toBe(32);
  });

  test("pointer type resolves to i32 (size 4)", () => {
    const s = new Sema();
    const info = (s as any).resolveType(ptr(n("uint64")));
    expect(info?.size).toBe(4);
    expect(info?.name).toBe("i32");
  });

  test("void type resolves correctly", () => {
    const s = new Sema();
    const info = (s as any).resolveType(vd());
    expect(info?.size).toBe(0);
    expect(info?.name).toBe("void");
  });

  test("const type resolves to underlying", () => {
    const s = new Sema();
    const info = (s as any).resolveType(cnst(n("uint64")));
    expect(info?.size).toBe(8);
  });

  test("unknown type returns null", () => {
    const s = new Sema();
    expect((s as any).resolveType(n("MysteryType"))).toBeNull();
  });

  test("sizeofType wrapper", () => {
    const s = new Sema();
    expect(s.sizeofType(n("uint64"))).toBe(8);
    expect(s.sizeofType(n("void"))).toBe(0);
  });
});

// ---- struct layout ----

describe("Sema — struct layout", () => {
  test("simple struct with scalar fields", () => {
    const s = new Sema();
    const members: Declaration[] = [
      fld("a", n("uint64")),
      fld("b", n("uint32")),
    ];
    const decl = sdecl("Test", members);
    const fields = s.computeStructLayout(decl);
    expect(fields).toHaveLength(2);
    expect(fields[0].name).toBe("a");
    expect(fields[0].offset).toBe(0);
    expect(fields[0].size).toBe(8);
    expect(fields[1].name).toBe("b");
    expect(fields[1].offset).toBe(8);
    expect(fields[1].size).toBe(4);
  });

  test("struct with mixed-width fields respects alignment", () => {
    const s = new Sema();
    const members: Declaration[] = [
      fld("v1", n("uint8")),
      fld("v2", n("uint64")),
      fld("v3", n("uint16")),
    ];
    const decl = sdecl("Aligned", members);
    const fields = s.computeStructLayout(decl);
    expect(fields[0].offset).toBe(0);
    expect(fields[0].size).toBe(1);
    expect(fields[1].offset).toBe(8);   // aligned to 8
    expect(fields[1].size).toBe(8);
    expect(fields[2].offset).toBe(16);
    expect(fields[2].size).toBe(2);
  });

  test("empty struct returns no fields", () => {
    const s = new Sema();
    const decl = sdecl("Empty", []);
    expect(s.computeStructLayout(decl)).toHaveLength(0);
  });
});

// ---- template instantiation ----

describe("Sema — template instantiation", () => {
  const arrayTemplateParams: TemplateParam[] = [
    { kind: "type", name: "T", span: NO_SPAN } as TemplateParam,
    { kind: "non_type", name: "L", type: n("uint64"), span: NO_SPAN } as TemplateParam,
  ];

  const makeArrayMembers = (): Declaration[] => [
    fld("_data", arr(n("T"), ident("L"))),
  ];

  const makeArrayTemplate = (): ClassTemplateDecl =>
    tdecl("Array", arrayTemplateParams, makeArrayMembers());

  const registerArrayTemplate = (s: Sema): void => {
    const tmpl = makeArrayTemplate();
    (s as any)._globalScope.types.set("Array", {
      kind: "struct",
      name: "Array",
      size: 0, alignment: 8,
      fields: [], enumerators: new Map(),
      isTemplate: true, templateParams: tmpl.params, templateAst: tmpl,
    });
  };

  const exprVal = (e: Expression): TypeSpec =>
    ({ kind: "expr_value", expr: e, span: NO_SPAN } as TypeSpec);

  test("Array<uint64, 4> has correct size", () => {
    const s = new Sema();
    registerArrayTemplate(s);
    const inst = s.instantiateTemplate("Array", [n("uint64"), exprVal(iLit("4"))]);
    expect(inst).not.toBeNull();
    expect(inst?.size).toBe(32); // uint64 = 8 bytes * 4
  });

  test("template instantiation is cached", () => {
    const s = new Sema();
    registerArrayTemplate(s);
    const a1 = s.instantiateTemplate("Array", [n("uint64"), exprVal(iLit("4"))]);
    const a2 = s.instantiateTemplate("Array", [n("uint64"), exprVal(iLit("4"))]);
    expect(a1).toBe(a2);
  });

  test("different Array instantiations have different sizes", () => {
    const s = new Sema();
    registerArrayTemplate(s);
    // Array<uint8, 4> → 4 bytes
    expect(s.instantiateTemplate("Array", [n("uint8"), exprVal(iLit("4"))])?.size).toBe(4);
    // Array<uint32, 4> → 16 bytes
    expect(s.instantiateTemplate("Array", [n("uint32"), exprVal(iLit("4"))])?.size).toBe(16);
    // Array<uint64, 8> → 64 bytes
    expect(s.instantiateTemplate("Array", [n("uint64"), exprVal(iLit("8"))])?.size).toBe(64);
  });

  test("unknown template returns null", () => {
    const s = new Sema();
    expect(s.instantiateTemplate("NotATemplate", [n("int")])).toBeNull();
  });
});

// ---- enum handling ----

describe("Sema — enum handling", () => {
  test("auto-incrementing enumerator values", () => {
    const s = new Sema();
    const enumDecl: Declaration = {
      kind: "enum",
      name: "TestEnum",
      isClass: false,
      members: [
        { name: "A", value: undefined, span: NO_SPAN },
        { name: "B", value: undefined, span: NO_SPAN },
        { name: "C", value: iLit("10"), span: NO_SPAN },
        { name: "D", value: undefined, span: NO_SPAN },
      ],
      span: NO_SPAN,
    } as Declaration;
    (s as any).registerDecl(enumDecl, (s as any)._globalScope);

    expect(ceval(s, ident("A"))).toBe(0n);
    expect(ceval(s, ident("B"))).toBe(1n);
    expect(ceval(s, ident("C"))).toBe(10n);
    expect(ceval(s, ident("D"))).toBe(11n);
  });
});
