// Validator unit tests: validateAndDesugar in isolation.
import { describe, test, expect } from "bun:test";
import { validateAndDesugar } from "../../src/validate";
import type {
  Declaration,
  StructDecl,
  FunctionDecl,
  VariableDecl,
  Statement,
  Expression,
  TypeSpec,
  Span,
} from "../../src/ast";

const NO_SPAN: Span = { start: 0, end: 0, line: 1, col: 1 };

// --- AST builder helpers ---- Cast through `any` so test builders stay concise. Every helper produces objects whose

const nt = (name: string): TypeSpec => ({ kind: "name", name, span: NO_SPAN }) as TypeSpec;
const vd = (): TypeSpec => ({ kind: "void", span: NO_SPAN }) as TypeSpec;
const cnst = (inner: TypeSpec): TypeSpec =>
  ({ kind: "const", valueType: inner, span: NO_SPAN }) as TypeSpec;

const ident = (name: string): Expression =>
  ({ kind: "identifier", name, span: NO_SPAN }) as Expression;
const iLit = (value: string): Expression =>
  ({ kind: "int_literal", value, span: NO_SPAN }) as Expression;
const bin = (left: Expression, op: string, right: Expression): Expression =>
  ({ kind: "binary_op", op, left, right, span: NO_SPAN }) as Expression;
const callx = (callee: Expression, args: Expression[]): Expression =>
  ({ kind: "call", callee, args, span: NO_SPAN }) as Expression;
const assign = (target: Expression, value: Expression): Expression =>
  ({ kind: "assign", op: "=", left: target, right: value, span: NO_SPAN }) as Expression;
const unary = (op: string, arg: Expression): Expression =>
  ({ kind: "unary_op", op, arg, span: NO_SPAN }) as Expression;

const eStmt = (expr: Expression): Statement =>
  ({ kind: "expression", expr, span: NO_SPAN }) as Statement;
const retStmt = (value?: Expression): Statement =>
  ({ kind: "return", value, span: NO_SPAN }) as Statement;
const compStmt = (body: Statement[]): Statement =>
  ({ kind: "compound", body, span: NO_SPAN }) as Statement;
const declStmt = (decl: Declaration): Statement =>
  ({ kind: "declaration", decl, span: NO_SPAN }) as Statement;
const ifStmt = (cond: Expression, then: Statement, else_?: Statement): Statement =>
  ({ kind: "if", cond, then, else_, span: NO_SPAN }) as Statement;
const forStmt = (
  init: Statement | undefined,
  cond: Expression | undefined,
  update: Expression | undefined,
  body: Statement,
): Statement => ({ kind: "for", init, cond, update, body, span: NO_SPAN }) as Statement;
const swStmt = (cond: Expression, body: Statement): Statement =>
  ({ kind: "switch", cond, body, span: NO_SPAN }) as Statement;
const caseStmt = (value: Expression, body: Statement[]): Statement =>
  ({ kind: "case", value, body, span: NO_SPAN }) as Statement;
const breakStmt = (): Statement => ({ kind: "break", span: NO_SPAN }) as Statement;
const ppOp = (arg: Expression, prefix: boolean): Expression =>
  ({
    kind: prefix ? "prefix_op" : "postfix_op",
    op: "++",
    arg,
    span: NO_SPAN,
    prefix,
  }) as Expression;

const varDecl = (
  name: string,
  type: TypeSpec,
  opts?: {
    init?: Expression;
    isConstexpr?: boolean;
    isStatic?: boolean;
    isExtern?: boolean;
    access?: "public" | "protected" | "private";
  },
): VariableDecl =>
  ({
    kind: "variable",
    name,
    type,
    init: opts?.init,
    isConstexpr: opts?.isConstexpr ?? false,
    isStatic: opts?.isStatic ?? false,
    isExtern: opts?.isExtern ?? false,
    isMember: false,
    access: opts?.access ?? "public",
    span: NO_SPAN,
  }) as VariableDecl;

const funcDecl = (
  name: string,
  params: { name: string; type: TypeSpec; defaultValue?: Expression }[],
  returnType: TypeSpec,
  body: Statement[],
  opts?: { isStatic?: boolean; noBody?: boolean },
): FunctionDecl =>
  ({
    kind: "function",
    name,
    params: params.map((p) => ({
      kind: "param" as const,
      name: p.name,
      type: p.type,
      span: NO_SPAN,
      defaultValue: p.defaultValue,
    })),
    returnType,
    body: opts?.noBody ? undefined : compStmt(body),
    isConstexpr: false,
    isStatic: opts?.isStatic ?? false,
    isInline: false,
    isExternC: false,
    isVirtual: false,
    isOverride: false,
    isDeleted: false,
    isDefault: false,
    span: NO_SPAN,
  }) as FunctionDecl;

const structDecl = (name: string, members: Declaration[], bases: TypeSpec[] = []): StructDecl =>
  ({ kind: "struct", name, members, bases, span: NO_SPAN }) as StructDecl;

const nsDecl = (name: string, body: Declaration[]): Declaration =>
  ({ kind: "namespace", name, body, span: NO_SPAN }) as Declaration;

const tu = (decls: Declaration[]): { declarations: Declaration[] } => ({ declarations: decls });

const validate = (decls: Declaration[]) => validateAndDesugar(tu(decls));
const hasError = (diags: ReturnType<typeof validateAndDesugar>, pattern: RegExp): boolean =>
  diags.some((d) => pattern.test(d.message));

// ---- rejection rules ----

describe("validateAndDesugar — rejection rules", () => {
  test("rejects global mutable variable", () => {
    const diags = validate([varDecl("g_bad", nt("uint64"), { init: iLit("0") })]);
    expect(hasError(diags, /global/i)).toBe(true);
  });

  test("allows global constexpr variable", () => {
    const diags = validate([varDecl("G_OK", nt("uint64"), { isConstexpr: true, init: iLit("7") })]);
    expect(hasError(diags, /global/i)).toBe(false);
  });

  test("allows global const variable", () => {
    const diags = validate([varDecl("G_CONST", cnst(nt("uint64")), { init: iLit("7") })]);
    expect(hasError(diags, /global/i)).toBe(false);
  });

  test("rejects duplicate struct member", () => {
    const diags = validate([
      structDecl("S", [varDecl("x", nt("uint64")), varDecl("x", nt("uint64"))]),
    ]);
    expect(hasError(diags, /duplicate member.*'x'/i)).toBe(true);
  });

  test("allows unique struct members", () => {
    const diags = validate([
      structDecl("S", [varDecl("x", nt("uint64")), varDecl("y", nt("uint64"))]),
    ]);
    expect(hasError(diags, /duplicate member/i)).toBe(false);
  });

  test("rejects duplicate function body with same signature", () => {
    const diags = validate([
      structDecl("S", [
        funcDecl("f", [{ name: "x", type: nt("uint64") }], vd(), [retStmt()]),
        funcDecl("f", [{ name: "x", type: nt("uint64") }], vd(), [retStmt()]),
      ]),
    ]);
    expect(hasError(diags, /already defined/i)).toBe(true);
  });

  test("allows overloaded functions (different signatures)", () => {
    const diags = validate([
      structDecl("S", [
        funcDecl("f", [{ name: "x", type: nt("uint64") }], vd(), [retStmt()]),
        funcDecl(
          "f",
          [
            { name: "x", type: nt("uint64") },
            { name: "y", type: nt("uint64") },
          ],
          vd(),
          [retStmt()],
        ),
      ]),
    ]);
    expect(hasError(diags, /already defined/i)).toBe(false);
  });

  test("rejects nested function definition", () => {
    const diags = validate([
      structDecl("S", [
        funcDecl("outer", [], vd(), [
          declStmt(funcDecl("inner", [], nt("uint64"), [retStmt(iLit("1"))], { isStatic: true })),
        ]),
      ]),
    ]);
    expect(hasError(diags, /nested/i)).toBe(true);
  });

  test("rejects void variable", () => {
    const s = structDecl("S", [funcDecl("f", [], vd(), [declStmt(varDecl("v", vd())), retStmt()])]);
    const diags = validate([s]);
    expect(hasError(diags, /void/i)).toBe(true);
  });

  test("rejects return with value from void function", () => {
    const s = structDecl("S", [funcDecl("f", [], vd(), [retStmt(iLit("5"))])]);
    const diags = validate([s]);
    expect(hasError(diags, /void/i)).toBe(true);
  });

  test("rejects missing return in non-void function", () => {
    const s = structDecl("S", [funcDecl("f", [], nt("uint64"), [eStmt(iLit("1"))])]);
    const diags = validate([s]);
    expect(hasError(diags, /must return/i)).toBe(true);
  });

  test("allows return with value from non-void function", () => {
    const s = structDecl("S", [funcDecl("f", [], nt("uint64"), [retStmt(iLit("1"))])]);
    const diags = validate([s]);
    expect(hasError(diags, /must return/i)).toBe(false);
  });

  test("allows void function with bare return", () => {
    const s = structDecl("S", [funcDecl("f", [], vd(), [retStmt()])]);
    const diags = validate([s]);
    expect(hasError(diags, /void/i)).toBe(false);
  });

  test("rejects non-static member call from static context", () => {
    const s = structDecl("S", [
      funcDecl("helper", [], nt("uint64"), [retStmt(iLit("1"))]),
      funcDecl("entry", [], vd(), [eStmt(callx(ident("helper"), [])), retStmt()], {
        isStatic: true,
      }),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /non-static/i)).toBe(true);
  });

  test("rejects duplicate case labels", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        swStmt(
          ident("x"),
          compStmt([caseStmt(iLit("1"), [breakStmt()]), caseStmt(iLit("1"), [breakStmt()])]),
        ),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /duplicate case/i)).toBe(true);
  });

  test("allows distinct case labels", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        swStmt(
          ident("x"),
          compStmt([caseStmt(iLit("1"), [breakStmt()]), caseStmt(iLit("2"), [breakStmt()])]),
        ),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /duplicate case/i)).toBe(false);
  });

  test("rejects division by zero", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [eStmt(bin(ident("x"), "/", iLit("0"))), retStmt()]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /division by zero/i)).toBe(true);
  });

  test("rejects modulo by zero", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [eStmt(bin(ident("x"), "%", iLit("0"))), retStmt()]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /division by zero/i)).toBe(true);
  });

  test("allows division by non-zero constant", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [eStmt(bin(ident("x"), "/", iLit("2"))), retStmt()]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /division by zero/i)).toBe(false);
  });

  test("rejects const assignment", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        declStmt(varDecl("c", cnst(nt("uint64")), { init: iLit("5") })),
        eStmt(assign(ident("c"), iLit("6"))),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /const|read-only/i)).toBe(true);
  });

  test("rejects shadowing: inner scope reuses outer name", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        declStmt(varDecl("v", nt("uint64"), { init: iLit("1") })),
        compStmt([declStmt(varDecl("v", nt("uint64"), { init: iLit("2") })), eStmt(ident("v"))]),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /shadow/i)).toBe(true);
  });

  test("rejects use-before-declaration", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        eStmt(assign(ident("v"), iLit("1"))),
        declStmt(varDecl("v", nt("uint64"))),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /before its declaration/i)).toBe(true);
  });

  test("rejects use-after-scope-exit", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        compStmt([declStmt(varDecl("v", nt("uint64"), { init: iLit("1") }))]),
        eStmt(ident("v")),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /scope|declaration/i)).toBe(true);
  });

  test("rejects direct recursion", () => {
    const s = structDecl("S", [
      funcDecl("fib", [{ name: "n", type: nt("uint64") }], nt("uint64"), [
        retStmt(callx(ident("fib"), [iLit("5")])),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /recursi/i)).toBe(true);
  });

  test("rejects mutual recursion", () => {
    const s = structDecl("S", [
      funcDecl("ping", [{ name: "n", type: nt("uint64") }], nt("uint64"), [
        retStmt(callx(ident("pong"), [ident("n")])),
      ]),
      funcDecl("pong", [{ name: "n", type: nt("uint64") }], nt("uint64"), [
        retStmt(callx(ident("ping"), [ident("n")])),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /recursi/i)).toBe(true);
  });

  test("allows non-recursive call", () => {
    const s = structDecl("S", [
      funcDecl("helper", [], nt("uint64"), [retStmt(iLit("1"))]),
      funcDecl("main", [], vd(), [eStmt(callx(ident("helper"), [])), retStmt()]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /recursi/i)).toBe(false);
  });

  test("rejects address-of-literal", () => {
    const s = structDecl("S", [funcDecl("f", [], vd(), [eStmt(unary("&", iLit("5"))), retStmt()])]);
    const diags = validate([s]);
    expect(hasError(diags, /address/i)).toBe(true);
  });

  test("rejects static local variable", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        declStmt(varDecl("s", nt("uint64"), { isStatic: true, init: iLit("0") })),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /static local/i)).toBe(true);
  });

  test("rejects call with too few arguments", () => {
    const s = structDecl("S", [
      funcDecl(
        "add",
        [
          { name: "x", type: nt("uint64") },
          { name: "y", type: nt("uint64") },
        ],
        nt("uint64"),
        [retStmt(bin(ident("x"), "+", ident("y")))],
      ),
      funcDecl("caller", [], vd(), [eStmt(callx(ident("add"), [iLit("1")])), retStmt()]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /argument/i)).toBe(true);
  });

  test("rejects call with too many arguments", () => {
    const s = structDecl("S", [
      funcDecl(
        "add",
        [
          { name: "x", type: nt("uint64") },
          { name: "y", type: nt("uint64") },
        ],
        nt("uint64"),
        [retStmt(bin(ident("x"), "+", ident("y")))],
      ),
      funcDecl("caller", [], vd(), [
        eStmt(callx(ident("add"), [iLit("1"), iLit("2"), iLit("3")])),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /argument/i)).toBe(true);
  });
});

// ---- desugaring: default arguments ----

describe("validateAndDesugar — default argument desugaring", () => {
  test("appends default expression to call with fewer args", () => {
    const fn = funcDecl(
      "add",
      [
        { name: "x", type: nt("uint64") },
        { name: "y", type: nt("uint64"), defaultValue: iLit("2") },
      ],
      nt("uint64"),
      [retStmt(bin(ident("x"), "+", ident("y")))],
    );

    const caller = funcDecl("caller", [], vd(), [
      eStmt(bin(ident("ignored"), "+", callx(ident("add"), [iLit("5")]))),
      retStmt(),
    ]);

    validate([structDecl("S", [fn, caller])]);

    const callExpr = (caller.body! as { kind: "compound"; body: Statement[] }).body[0] as {
      kind: "expression";
      expr: Expression;
    };
    const callNode = (callExpr.expr as { kind: "binary_op"; left: Expression; right: Expression })
      .right as { kind: "call"; args: Expression[] };
    expect(callNode.kind).toBe("call");
    expect(callNode.args).toHaveLength(2);
    expect(callNode.args[1].kind).toBe("int_literal");
    expect((callNode.args[1] as { value: string }).value).toBe("2");
  });

  test("does not add defaults when full args provided", () => {
    const fn = funcDecl(
      "add",
      [
        { name: "x", type: nt("uint64") },
        { name: "y", type: nt("uint64"), defaultValue: iLit("2") },
      ],
      nt("uint64"),
      [retStmt(bin(ident("x"), "+", ident("y")))],
    );

    const caller = funcDecl("caller", [], vd(), [
      eStmt(callx(ident("add"), [iLit("5"), iLit("7")])),
      retStmt(),
    ]);

    validate([structDecl("S", [fn, caller])]);

    const callExpr = (caller.body! as { kind: "compound"; body: Statement[] }).body[0] as {
      kind: "expression";
      expr: Expression;
    };
    const callNode = callExpr.expr as { kind: "call"; args: Expression[] };
    expect(callNode.kind).toBe("call");
    expect(callNode.args).toHaveLength(2);
    expect((callNode.args[1] as { value: string }).value).toBe("7");
  });
});

// ---- scope behavior ----

describe("validateAndDesugar — scope rules", () => {
  test("sibling scopes can reuse names (no error)", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        forStmt(
          declStmt(varDecl("i", nt("uint64"), { init: iLit("0") })),
          bin(ident("i"), "<", iLit("3")),
          ppOp(ident("i"), false),
          compStmt([eStmt(ident("i"))]),
        ),
        forStmt(
          declStmt(varDecl("i", nt("uint64"), { init: iLit("0") })),
          bin(ident("i"), "<", iLit("3")),
          ppOp(ident("i"), false),
          compStmt([eStmt(ident("i"))]),
        ),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /shadow/i)).toBe(false);
  });

  test("multi-declarator statement works", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        declStmt(varDecl("x", nt("uint64"), { init: iLit("1") })),
        declStmt(varDecl("y", nt("uint64"), { init: iLit("2") })),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  test("block-scope function prototype is allowed", () => {
    const s = structDecl("S", [
      funcDecl("f", [], vd(), [
        declStmt(
          funcDecl("h", [{ name: "x", type: nt("uint64") }], nt("uint64"), [], { noBody: true }),
        ),
        eStmt(callx(ident("h"), [iLit("1")])),
        retStmt(),
      ]),
    ]);
    const diags = validate([s]);
    expect(hasError(diags, /nested/i)).toBe(false);
  });
});
