// Validation runs after parse and before codegen.

import type {
  Declaration,
  StructDecl,
  FunctionDecl,
  VariableDecl,
  Statement,
  Expression,
  TypeSpec,
  Span,
} from "./ast";
import { parseIntLiteral } from "./lexer";

export interface ValidateDiagnostic {
  severity: "error";
  message: string;
  span: Span;
}

interface FnSig {
  decl: FunctionDecl;
  minArgs: number;
  maxArgs: number;
}

const NO_SPAN: Span = { start: 0, end: 0, line: 0, col: 0 };

function validateAndDesugarBase(tu: { declarations: Declaration[] }): ValidateDiagnostic[] {
  const v = new Validator();
  v.runTopLevel(tu.declarations);
  return v.diagnostics;
}

// Strip const/reference wrappers down to the underlying type.
function unwrapType(t: TypeSpec): TypeSpec {
  if (t.kind === "const") {
    return unwrapType(t.valueType);
  }
  if (t.kind === "reference") {
    return unwrapType(t.refereed);
  }
  return t;
}

function isVoidType(t: TypeSpec): boolean {
  const u = unwrapType(t);
  return u.kind === "void" || (u.kind === "name" && u.name === "void");
}

function isConstType(t: TypeSpec): boolean {
  if (t.kind === "const") {
    return true;
  }
  if (t.kind === "reference") {
    return t.refereed.kind === "const";
  }
  return false;
}

// Canonical key for a case label / constant operand: numeric literals normalize through BigInt (0x1 and 1 collide),
function constKey(e: Expression): string | null {
  if (e.kind === "int_literal") {
    try {
      return `#${BigInt(e.value.replace(/[uUlL]+$/, ""))}`;
    } catch {
      return `#${e.value}`;
    }
  }
  if (e.kind === "char_literal") {
    return `#${e.value}`;
  }
  if (e.kind === "bool_literal") {
    return `#${e.value ? 1 : 0}`;
  }
  if (e.kind === "unary_op" && e.op === "-") {
    const inner = constKey(e.arg);
    return inner?.startsWith("#") ? `#${-BigInt(inner.slice(1))}` : null;
  }
  if (e.kind === "identifier") {
    return `id:${e.name}`;
  }
  if (e.kind === "qualified_name") {
    return `id:${e.namespace}::${e.name}`;
  }
  return null;
}

// True when the literal is integer zero (any radix/suffix).
function isZeroLiteral(e: Expression): boolean {
  return constKey(e) === "#0";
}

function isLiteral(e: Expression): boolean {
  return (
    e.kind === "int_literal" ||
    e.kind === "float_literal" ||
    e.kind === "bool_literal" ||
    e.kind === "char_literal" ||
    e.kind === "string_literal"
  );
}

const CONST_TYPE_SIZE: Record<string, bigint> = {
  bool: 1n,
  bit: 1n,
  sint8: 1n,
  uint8: 1n,
  sint16: 2n,
  uint16: 2n,
  sint32: 4n,
  uint32: 4n,
  sint64: 8n,
  uint64: 8n,
  uint128: 16n,
  id: 32n,
  m256i: 32n,
  int: 4n,
  unsigned: 4n,
  signed: 4n,
};

// Small, side-effect-free integral constant evaluator used by validation. Unknown identifiers
function evalIntegralConst(
  e: Expression,
  resolve?: (name: string) => bigint | null,
): bigint | null {
  try {
    switch (e.kind) {
      case "int_literal":
        return parseIntLiteral(e.value);
      case "bool_literal":
        return e.value ? 1n : 0n;
      case "char_literal":
        return BigInt(e.value);
      case "identifier":
        return resolve?.(e.name) ?? null;
      case "qualified_name":
        return resolve?.(`${e.namespace}::${e.name}`) ?? null;
      case "paren":
        return evalIntegralConst(e.expr, resolve);
      case "unary_op": {
        const a = evalIntegralConst(e.arg, resolve);
        if (a === null) return null;
        if (e.op === "-") return -a;
        if (e.op === "+") return a;
        if (e.op === "~") return ~a;
        if (e.op === "!") return a === 0n ? 1n : 0n;
        return null;
      }
      case "binary_op": {
        const l = evalIntegralConst(e.left, resolve);
        const r = evalIntegralConst(e.right, resolve);
        if (l === null || r === null) return null;
        switch (e.op) {
          case "+":
            return l + r;
          case "-":
            return l - r;
          case "*":
            return l * r;
          case "/":
            return r === 0n ? null : l / r;
          case "%":
            return r === 0n ? null : l % r;
          case "<<":
            return l << r;
          case ">>":
            return l >> r;
          case "&":
            return l & r;
          case "|":
            return l | r;
          case "^":
            return l ^ r;
          case "==":
            return l === r ? 1n : 0n;
          case "!=":
            return l !== r ? 1n : 0n;
          case "<":
            return l < r ? 1n : 0n;
          case ">":
            return l > r ? 1n : 0n;
          case "<=":
            return l <= r ? 1n : 0n;
          case ">=":
            return l >= r ? 1n : 0n;
          case "&&":
            return l !== 0n && r !== 0n ? 1n : 0n;
          case "||":
            return l !== 0n || r !== 0n ? 1n : 0n;
          default:
            return null;
        }
      }
      case "ternary": {
        const c = evalIntegralConst(e.cond, resolve);
        return c === null ? null : evalIntegralConst(c !== 0n ? e.then : e.else_, resolve);
      }
      case "c_cast":
      case "static_cast":
        return evalIntegralConst(e.expr, resolve);
      case "sizeof_type": {
        const t = unwrapType(e.type);
        return t.kind === "name" ? (CONST_TYPE_SIZE[t.name] ?? null) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Canonical spelling of a type for signature comparison.
function typeKey(t: TypeSpec): string {
  switch (t.kind) {
    case "name":
      return t.name;
    case "const":
      return `const ${typeKey(t.valueType)}`;
    case "reference":
      return `${typeKey(t.refereed)}&`;
    case "pointer":
      return `${typeKey(t.pointee)}*`;
    case "template_instance":
      return `${t.name}<${t.args.map(typeKey).join(",")}>`;
    case "array":
      return `${typeKey(t.elem)}[]`;
    case "void":
      return "void";
    default:
      return t.kind;
  }
}

function paramSignature(fn: FunctionDecl): string {
  return fn.params.map((p) => typeKey(p.type)).join(";");
}

class Validator {
  diagnostics: ValidateDiagnostic[] = [];

  private seen = new Set<string>();

  private currentFn: FunctionDecl | null = null;

  private loopDepth = 0;

  private constants = new Map<string, bigint>();

  private aggregateNames = new Set<string>(["id", "m256i", "uint128"]);

  // Typedef aliases, name → target type key: qpi.h's `typedef m256i id` plus the contract's own typedef_decls. Aggregate type
  private typeAliases = new Map<string, string>([
    ["id", "m256i"],
    ["uint128_t", "uint128"],
  ]);

  private aggregateFieldCount = new Map<string, number>();

  private structFields = new Map<string, Map<string, TypeSpec>>();

  private currentTypes = new Map<string, TypeSpec>();

  private currentMemberFns = new Map<string, FnSig>();

  private canonTypeKey(t: TypeSpec): string {
    const u = unwrapType(t);

    // Template value arguments canonicalize to their constant values, so Array<uint8, ALIGNED_A> and Array<uint8, ALIGNED_B> compare equal when both
    if (u.kind === "template_instance") {
      const args = u.args.map((a) => {
        if (a.kind === "name") {
          const v = this.constants.get(a.name);
          if (v !== undefined) {
            return v.toString();
          }
        }
        return this.canonTypeKey(a);
      });
      return `${u.name}<${args.join(",")}>`;
    }

    let k = typeKey(u);
    for (let i = 0; i < 8; i++) {
      const next = this.typeAliases.get(k);
      if (!next || next === k) {
        break;
      }
      k = next;
    }
    return k;
  }

  private error(message: string, span: Span | undefined): void {
    const sp = span ?? NO_SPAN;
    const key = `${message}@${sp.line}`;
    if (this.seen.has(key)) {
      return;
    }

    this.seen.add(key);
    this.diagnostics.push({ severity: "error", message, span: sp });
  }

  // ---- Top level ----

  runTopLevel(decls: Declaration[]): void {
    const typeNames = new Set<string>();
    for (const d of decls) {
      // A memberless struct is a forward declaration (`struct StateData;`), not a definition.
      const isForwardDecl = d.kind === "struct" && d.members.length === 0;
      if (
        (d.kind === "struct" ||
          d.kind === "class_template" ||
          d.kind === "enum" ||
          d.kind === "typedef_decl") &&
        d.name &&
        !isForwardDecl
      ) {
        if (typeNames.has(d.name)) this.error(`duplicate type definition '${d.name}'`, d.span);
        typeNames.add(d.name);
      }
      if (d.kind === "typedef_decl" && d.name) {
        this.typeAliases.set(d.name, typeKey(unwrapType((d as { type: TypeSpec }).type)));
      }
      switch (d.kind) {
        case "variable":
          this.checkGlobalVariable(d);
          break;
        case "struct":
          this.checkStruct(d);
          break;
        case "namespace":
          this.runTopLevel(d.body);
          break;
        case "function":
          if (d.body) {
            this.checkFunctionBody(d, new Map());
          }
          break;
        case "enum":
          this.collectEnumConstants(d);
          break;
        case "static_assert_decl":
          this.checkStaticAssert(d.cond, d.message, d.span);
          break;
        case "class_template":
          this.checkStruct(d as unknown as StructDecl);
          break;
      }
    }
  }

  // Contracts run on consensus state only: a file-scope mutable lives outside the hashed state and silently diverges between
  private checkGlobalVariable(v: VariableDecl): void {
    if (v.isConstexpr || v.isExtern || isConstType(v.type)) {
      // File-scope constexpr constants feed template-argument canonicalization (canonTypeKey) and static_assert evaluation.
      if (v.init) {
        const value = evalIntegralConst(v.init, (name) => this.constants.get(name) ?? null);
        if (value !== null) {
          this.constants.set(v.name, value);
        }
      }
      return;
    }

    this.error(
      `global variable '${v.name}' is not allowed in a contract — state must live in the contract state struct`,
      v.span,
    );
  }

  // ---- Structs ----

  private checkStruct(s: StructDecl): void {
    if (s.name) this.aggregateNames.add(s.name);
    if (s.name)
      this.aggregateFieldCount.set(
        s.name,
        s.members.filter((m) => m.kind === "variable" && !m.isStatic && !m.isConstexpr).length,
      );
    if (s.name)
      this.structFields.set(
        s.name,
        new Map(
          s.members
            .filter((m): m is VariableDecl => m.kind === "variable")
            .map((m) => [m.name, m.type]),
        ),
      );
    const fieldNames = new Set<string>();
    const typeNames = new Set<string>();
    const fnBodies = new Map<string, FunctionDecl>();
    const fnSigs = new Map<string, FnSig>();

    for (const m of s.members) {
      // A memberless struct is a forward declaration (`struct StateData;`), not a definition.
      const isForwardDecl = m.kind === "struct" && m.members.length === 0;
      if (
        (m.kind === "struct" ||
          m.kind === "class_template" ||
          m.kind === "enum" ||
          m.kind === "typedef_decl") &&
        m.name &&
        !isForwardDecl
      ) {
        if (typeNames.has(m.name))
          this.error(`duplicate type definition '${m.name}' in struct '${s.name}'`, m.span);
        typeNames.add(m.name);
      }
      if (m.kind === "typedef_decl" && m.name) {
        this.typeAliases.set(m.name, typeKey(unwrapType((m as { type: TypeSpec }).type)));
      }
      if (m.kind === "variable") {
        // Anonymous-union alternatives intentionally alias storage; only named duplicates in the same struct are redefinitions.
        if (fieldNames.has(m.name)) {
          this.error(`duplicate member '${m.name}' in struct '${s.name}'`, m.span);
        }
        fieldNames.add(m.name);
        if (m.init && (m.isConstexpr || isConstType(m.type))) {
          const value = evalIntegralConst(m.init, (name) => this.constants.get(name) ?? null);
          if (value !== null) this.constants.set(m.name, value);
        }
      }

      if (m.kind === "struct") {
        if (m.name) this.aggregateNames.add(m.name);
        this.checkStruct(m);
      }

      if (m.kind === "enum") {
        this.collectEnumConstants(m);
      }

      if (m.kind === "static_assert_decl") {
        this.checkStaticAssert(m.cond, m.message, m.span);
      }

      if (m.kind === "function") {
        const sig: FnSig = {
          decl: m,
          minArgs: m.params.filter((p) => !p.defaultValue).length,
          maxArgs: m.params.length,
        };
        if (m.body) {
          // Two definitions with the same parameter signature are a redefinition. Overloads
          const prev = fnBodies.get(m.name);
          if (prev && paramSignature(prev) === paramSignature(m)) {
            this.error(
              `'${m.name}' is already defined in struct '${s.name}' with the same signature`,
              m.span,
            );
          }
          if (!prev) {
            fnBodies.set(m.name, m);
          }
          if (!fnSigs.has(m.name) || fnSigs.get(m.name)!.decl.body === undefined) {
            fnSigs.set(m.name, sig);
          }
        } else if (!fnSigs.has(m.name)) {
          fnSigs.set(m.name, sig);
        }
      }
    }

    // Overloaded names can't be arity-checked or default-desugared without type-based resolution — exclude them from call checks entirely.
    const bodyCount = new Map<string, number>();
    for (const m of s.members) {
      if (m.kind === "function" && m.body) {
        bodyCount.set(m.name, (bodyCount.get(m.name) ?? 0) + 1);
      }
    }
    for (const [name, n] of bodyCount) {
      if (n > 1) {
        fnSigs.delete(name);
      }
    }

    for (const fn of fnBodies.values()) {
      this.checkFunctionBody(fn, fnSigs);
    }

    this.checkRecursion(s, fnBodies);
  }

  // Qubic contracts must have statically bounded stacks: any call cycle among a struct's member functions (direct or mutual)
  private checkRecursion(s: StructDecl, fnBodies: Map<string, FunctionDecl>): void {
    const edges = new Map<string, Set<string>>();
    for (const [name, fn] of fnBodies) {
      const callees = new Set<string>();
      this.walkStatements(fn.body!, (stmt) => {
        this.walkExpressions(stmt, (e) => {
          if (e.kind === "call") {
            if (e.callee.kind === "identifier" && fnBodies.has(e.callee.name)) {
              callees.add(e.callee.name);
            }
            if (
              e.callee.kind === "member_access" &&
              e.callee.object.kind === "identifier" &&
              e.callee.object.name === "this" &&
              fnBodies.has(e.callee.member)
            ) {
              callees.add(e.callee.member);
            }
          }
        });
      });
      edges.set(name, callees);
    }

    const state = new Map<string, "visiting" | "done">();
    const visit = (name: string, path: string[]): void => {
      const st = state.get(name);
      if (st === "done") {
        return;
      }
      if (st === "visiting") {
        const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
        this.error(`recursion is not allowed in a contract: ${cycle}`, fnBodies.get(name)?.span);
        return;
      }

      state.set(name, "visiting");
      for (const callee of edges.get(name) ?? []) {
        visit(callee, [...path, name]);
      }
      state.set(name, "done");
    };
    for (const name of edges.keys()) {
      visit(name, []);
    }
  }

  // ---- Function bodies ----

  private checkFunctionBody(fn: FunctionDecl, memberFns: Map<string, FnSig>): void {
    this.currentFn = fn;
    this.loopDepth = 0;
    this.currentMemberFns = memberFns;
    this.currentTypes = new Map(fn.params.map((p) => [p.name, p.type]));

    // Every local declared anywhere in the function, for classifying bare identifiers: names outside this set belong to members/parameters/constants
    const allLocals = new Set<string>();
    this.walkStatements(fn.body!, (stmt) => {
      if (stmt.kind === "declaration" && stmt.decl.kind === "variable" && !stmt.decl.isMember) {
        allLocals.add(stmt.decl.name);
        this.currentTypes.set(stmt.decl.name, stmt.decl.type);
      }
    });
    this.checkReturns(fn);

    const constParams = new Set<string>();
    for (const p of fn.params) {
      if (isConstType(p.type)) {
        constParams.add(p.name);
      }
    }

    const scopes: Array<Map<string, { const: boolean }>> = [new Map()];
    this.walkScope(fn.body!, fn, memberFns, allLocals, constParams, scopes);
  }

  private checkReturns(fn: FunctionDecl): void {
    const isVoid = isVoidType(fn.returnType);
    let valueReturns = 0;

    this.walkStatements(fn.body!, (stmt) => {
      if (stmt.kind !== "return") {
        return;
      }
      if (stmt.value && isVoid) {
        this.error(`void function '${fn.name}' cannot return a value`, stmt.span);
      }
      if (stmt.value) {
        valueReturns++;
        const actual = this.inferSimpleType(stmt.value);
        if (this.isAggregateType(fn.returnType) && actual && !this.isAggregateType(actual)) {
          this.error(
            `return type is incompatible: cannot convert scalar expression to aggregate '${typeKey(fn.returnType)}'`,
            stmt.span,
          );
        } else if (
          actual &&
          this.isAggregateType(fn.returnType) &&
          this.isAggregateType(actual) &&
          this.canonTypeKey(actual) !== this.canonTypeKey(fn.returnType)
        ) {
          this.error(
            `return type mismatch: cannot convert '${typeKey(actual)}' to '${typeKey(fn.returnType)}'`,
            stmt.span,
          );
        }
      }
    });

    if (!isVoid && valueReturns === 0) {
      this.error(`function '${fn.name}' must return a value`, fn.span);
    } else if (!isVoid && !this.guaranteesReturn(fn.body!)) {
      this.error(
        `non-void function '${fn.name}' has a reachable fallthrough path without a return value`,
        fn.span,
      );
    }
  }

  private guaranteesReturn(stmt: Statement): boolean {
    if (stmt.kind === "return") return true;
    if (stmt.kind === "compound") {
      for (const child of stmt.body) if (this.guaranteesReturn(child)) return true;
      return false;
    }
    if (stmt.kind === "if")
      return !!stmt.else_ && this.guaranteesReturn(stmt.then) && this.guaranteesReturn(stmt.else_);
    if (stmt.kind === "switch") {
      // A switch guarantees a return when it has a default label, no arm can break out of it,
      const body = stmt.body.kind === "compound" ? stmt.body.body : [stmt.body];
      const breaksOut = (s: Statement): boolean => {
        if (s.kind === "break") return true;
        if (s.kind === "compound") return s.body.some(breaksOut);
        if (s.kind === "if") return breaksOut(s.then) || (!!s.else_ && breaksOut(s.else_));
        return false;
      };
      const last = body[body.length - 1];
      return (
        body.some((s) => s.kind === "default") &&
        !body.some(breaksOut) &&
        !!last &&
        this.guaranteesReturn(last)
      );
    }
    return false;
  }

  private collectEnumConstants(e: Declaration & { kind: "enum" }): void {
    const names = new Set<string>();
    let next = 0n;
    for (const member of e.members) {
      if (names.has(member.name)) this.error(`duplicate enumerator '${member.name}'`, member.span);
      names.add(member.name);
      const value = member.value
        ? evalIntegralConst(member.value, (name) => this.constants.get(name) ?? null)
        : next;
      if (value !== null) {
        this.constants.set(member.name, value);
        if (e.name) this.constants.set(`${e.name}::${member.name}`, value);
        next = value + 1n;
      }
    }
  }

  private checkStaticAssert(cond: Expression, message: Expression | undefined, span: Span): void {
    const value = evalIntegralConst(cond, (name) => this.constants.get(name) ?? null);
    if (value === 0n) {
      const detail = message?.kind === "string_literal" ? `: ${message.value}` : "";
      this.error(`static assertion failed${detail}`, span);
    }
  }

  // Ordered walk with a scope stack: declarations register in the innermost scope, identifier uses must resolve to an
  private walkScope(
    stmt: Statement,
    fn: FunctionDecl,
    memberFns: Map<string, FnSig>,
    allLocals: Set<string>,
    constParams: Set<string>,
    scopes: Array<Map<string, { const: boolean }>>,
  ): void {
    const recurse = (s: Statement) =>
      this.walkScope(s, fn, memberFns, allLocals, constParams, scopes);
    const inOwnScope = (s: Statement, extra?: () => void) => {
      scopes.push(new Map());
      if (extra) {
        extra();
      }
      recurse(s);
      scopes.pop();
    };

    switch (stmt.kind) {
      case "compound":
        // A multi-declarator statement (`uint64 x = 1, y = 3;`) is drained by the parser into a synthetic
        if ((stmt as any).synthetic) {
          for (const s of stmt.body) {
            recurse(s);
          }
          break;
        }

        scopes.push(new Map());
        for (const s of stmt.body) {
          recurse(s);
        }
        scopes.pop();
        break;

      case "declaration":
        this.checkDeclarationStatement(stmt, scopes);
        if (stmt.decl.kind === "variable" && stmt.decl.init) {
          this.checkExpression(stmt.decl.init, memberFns, allLocals, constParams, scopes);
        }
        break;

      case "if":
        this.checkExpression(stmt.cond, memberFns, allLocals, constParams, scopes);
        inOwnScope(stmt.then);
        if (stmt.else_) {
          inOwnScope(stmt.else_);
        }
        break;

      case "for":
        scopes.push(new Map());
        if (stmt.init) {
          recurse(stmt.init);
        }
        if (stmt.cond) {
          this.checkExpression(stmt.cond, memberFns, allLocals, constParams, scopes);
        }
        if (stmt.update) {
          this.checkExpression(stmt.update, memberFns, allLocals, constParams, scopes);
        }
        this.loopDepth++;
        inOwnScope(stmt.body);
        this.loopDepth--;
        scopes.pop();
        break;

      case "while":
        this.checkExpression(stmt.cond, memberFns, allLocals, constParams, scopes);
        this.loopDepth++;
        inOwnScope(stmt.body);
        this.loopDepth--;
        break;

      case "do_while":
        this.loopDepth++;
        inOwnScope(stmt.body);
        this.loopDepth--;
        this.checkExpression(stmt.cond, memberFns, allLocals, constParams, scopes);
        break;

      case "switch":
        this.checkExpression(stmt.cond, memberFns, allLocals, constParams, scopes);
        this.checkSwitchCases(stmt.body, allLocals);
        inOwnScope(stmt.body);
        break;

      case "continue":
        if (this.loopDepth === 0) this.error(`continue statement is outside a loop`, stmt.span);
        break;

      case "static_assert":
        this.checkStaticAssert(stmt.cond, stmt.message, stmt.span);
        break;

      case "return":
        if (stmt.value) {
          this.checkExpression(stmt.value, memberFns, allLocals, constParams, scopes);
        }
        break;

      case "expression":
        this.checkExpression(stmt.expr, memberFns, allLocals, constParams, scopes);
        break;
    }
  }

  private checkDeclarationStatement(
    stmt: Statement & { kind: "declaration" },
    scopes: Array<Map<string, { const: boolean }>>,
  ): void {
    const d = stmt.decl;

    if (d.kind === "function") {
      if (d.body) {
        this.error(
          `function '${d.name}' cannot be defined nested inside another function`,
          stmt.span,
        );
      }
      return;
    }
    if (d.kind === "struct") {
      this.checkStruct(d);
      return;
    }
    if (d.kind !== "variable") {
      return;
    }

    if (isVoidType(d.type)) {
      this.error(`variable '${d.name}' cannot have type void`, stmt.span);
    }
    if (d.isStatic && !d.isConstexpr) {
      this.error(
        `static local variable '${d.name}' is not allowed in a contract — its lifetime would outlive the call and bypass consensus state`,
        stmt.span,
      );
    }

    if (d.init) this.checkInitializerCardinality(d.type, d.init, stmt.span);

    const current = scopes[scopes.length - 1];
    if (current.has(d.name)) {
      this.error(`'${d.name}' is already declared in this scope`, stmt.span);
    } else if (d.name !== "interContractCallError") {
      // CALL_OTHER_CONTRACT_FUNCTION / INVOKE_OTHER_CONTRACT_PROCEDURE declare `InterContractCallError interContractCallError;` at the call site, so nested calls shadow by design and each
      for (let i = scopes.length - 2; i >= 0; i--) {
        if (scopes[i].has(d.name)) {
          this.error(
            `'${d.name}' shadows a declaration in an enclosing scope — locals share one slot per name, so shadowing is not supported`,
            stmt.span,
          );
          break;
        }
      }
    }
    current.set(d.name, { const: isConstType(d.type) });
  }

  private checkInitializerCardinality(type: TypeSpec, init: Expression, span: Span): void {
    const args =
      init.kind === "initializer_list" ? init.exprs : init.kind === "construct" ? init.args : null;
    if (!args) return;
    const t = unwrapType(type);
    if (t.kind === "array") {
      const size = evalIntegralConst(t.size, (name) => this.constants.get(name) ?? null);
      if (size !== null && size > 0n && BigInt(args.length) > size) {
        this.error(`too many initializers for array bound ${size}`, span);
      }
      for (const arg of args) this.checkInitializerCardinality(t.elem, arg, arg.span);
      return;
    }
    if (t.kind === "name") {
      const fields = this.aggregateFieldCount.get(t.name);
      if (fields !== undefined && args.length > fields) {
        this.error(`too many initializers for aggregate '${t.name}' (${fields} fields)`, span);
      }
    }
  }

  private checkSwitchCases(body: Statement, allLocals: Set<string>): void {
    const keys = new Set<string>();
    let defaults = 0;

    const scan = (s: Statement): void => {
      switch (s.kind) {
        case "case": {
          const value = evalIntegralConst(s.value, (name) => this.constants.get(name) ?? null);
          const key = value === null ? null : `#${value}`;
          if (value === null && s.value.kind === "identifier" && allLocals.has(s.value.name)) {
            this.error(`case label must be an integral constant expression`, s.span);
          }
          if (key !== null) {
            if (keys.has(key)) {
              this.error(`duplicate case label`, s.span);
            }
            keys.add(key);
          }
          break;
        }
        case "default":
          defaults++;
          if (defaults > 1) this.error(`duplicate default label`, s.span);
          break;
        case "compound":
          for (const c of s.body) {
            scan(c);
          }
          break;
        case "if":
          scan(s.then);
          if (s.else_) {
            scan(s.else_);
          }
          break;
        case "for":
        case "while":
        case "do_while":
          scan(s.body);
          break;
      }
    };
    scan(body);
  }

  // ---- Expressions ----

  private checkExpression(
    root: Expression,
    memberFns: Map<string, FnSig>,
    allLocals: Set<string>,
    constParams: Set<string>,
    scopes: Array<Map<string, { const: boolean }>>,
  ): void {
    const lookup = (name: string): { const: boolean } | null => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const hit = scopes[i].get(name);
        if (hit) {
          return hit;
        }
      }
      return null;
    };

    const walk = (e: Expression): void => {
      switch (e.kind) {
        case "identifier":
          if (allLocals.has(e.name) && !lookup(e.name)) {
            this.error(
              `'${e.name}' is used before its declaration (or outside the scope that declares it)`,
              e.span,
            );
          }
          break;

        case "assign": {
          const leftType = this.inferSimpleType(e.left);
          const rightType = this.inferSimpleType(e.right);
          if (
            leftType &&
            rightType &&
            this.isAggregateType(leftType) &&
            this.isAggregateType(rightType) &&
            this.canonTypeKey(leftType) !== this.canonTypeKey(rightType)
          ) {
            this.error(
              `incompatible aggregate assignment from '${typeKey(rightType)}' to '${typeKey(leftType)}'`,
              e.span,
            );
          }
          this.checkAssignTarget(e.left, constParams, lookup);
          walk(e.left);
          walk(e.right);
          break;
        }

        case "prefix_op":
        case "postfix_op":
          this.checkAssignTarget(e.arg, constParams, lookup);
          walk(e.arg);
          break;

        case "unary_op":
          if (e.op === "&" && isLiteral(e.arg)) {
            this.error(`cannot take the address of a literal`, e.span);
          }
          walk(e.arg);
          break;

        case "binary_op":
          if ((e.op === "/" || e.op === "%") && isZeroLiteral(e.right)) {
            this.error(`constant division by zero`, e.span);
          }
          walk(e.left);
          walk(e.right);
          break;

        case "call": {
          const name =
            e.callee.kind === "identifier"
              ? e.callee.name
              : e.callee.kind === "member_access" &&
                  e.callee.object.kind === "identifier" &&
                  e.callee.object.name === "this"
                ? e.callee.member
                : null;
          if (e.callee.kind === "member_access") {
            const method = e.callee.member;
            const object = e.callee.object;
            const receiverType = this.inferSimpleType(object);
            const receiver = receiverType ? unwrapType(receiverType) : null;
            const isArray = receiver?.kind === "template_instance" && receiver.name === "Array";
            if (isArray && method === "set" && e.args.length !== 2) {
              this.error(`container set expects 2 argument(s) but got ${e.args.length}`, e.span);
            }
            // state.get() is a zero-argument accessor; a get call with operands is a container get.
            if (isArray && method === "get" && e.args.length !== 1) {
              this.error(`container get expects 1 argument but got ${e.args.length}`, e.span);
            }
            if (
              this.isPublicFunctionContext() &&
              object.kind === "identifier" &&
              object.name === "state" &&
              method === "mut"
            ) {
              this.error(`public function is read-only and cannot call state.mut()`, e.span);
            }
          }
          const sig =
            name !== null && !lookup(name) && !allLocals.has(name)
              ? memberFns.get(name)
              : undefined;
          if (sig) {
            // Native rejects a bare non-static member call from a static context (every macro-generated entry body is static) —
            if (this.currentFn?.isStatic && !sig.decl.isStatic) {
              this.error(
                `cannot call non-static member function '${name}' from a static context — declare it static`,
                e.span,
              );
            }
            if (e.args.length < sig.minArgs || e.args.length > sig.maxArgs) {
              const want =
                sig.minArgs === sig.maxArgs ? `${sig.maxArgs}` : `${sig.minArgs}..${sig.maxArgs}`;
              this.error(`'${name}' expects ${want} argument(s) but got ${e.args.length}`, e.span);
            } else {
              // Desugar defaults: append the declaration's default expressions so codegen emits the full argument list (C++ evaluates defaults at
              for (let i = e.args.length; i < sig.maxArgs; i++) {
                e.args.push(sig.decl.params[i].defaultValue!);
              }
            }
            for (let i = 0; i < Math.min(e.args.length, sig.decl.params.length); i++) {
              const paramType = sig.decl.params[i].type;
              const argType = this.inferSimpleType(e.args[i]);
              if (
                argType &&
                this.isAggregateType(paramType) &&
                this.isAggregateType(argType) &&
                this.canonTypeKey(paramType) !== this.canonTypeKey(argType)
              ) {
                this.error(
                  `argument ${i + 1} to '${name}' has incompatible aggregate type '${typeKey(argType)}'; expected '${typeKey(paramType)}'`,
                  e.args[i].span,
                );
              }
              if (paramType.kind !== "reference" || isConstType(paramType)) continue;
              const arg = e.args[i];
              if (!this.isWritableReferenceArgument(arg, constParams, lookup)) {
                this.error(
                  `argument ${i + 1} to '${name}' cannot bind to a non-const reference`,
                  arg.span,
                );
              }
            }
          }
          if (e.callee.kind !== "identifier") {
            walk(e.callee);
          }
          for (const a of e.args) {
            walk(a);
          }
          break;
        }

        case "template_call":
          for (const a of e.args) {
            walk(a);
          }
          break;

        case "member_access":
          walk(e.object);
          break;
        case "subscript":
          walk(e.object);
          walk(e.index);
          break;
        case "ternary":
          walk(e.cond);
          walk(e.then);
          walk(e.else_);
          break;
        case "sequence":
          for (const x of e.exprs) {
            walk(x);
          }
          break;
        case "c_cast":
        case "static_cast":
        case "reinterpret_cast":
          walk(e.expr);
          break;
        case "construct":
        case "initializer_list":
          for (const x of (e as any).args ?? (e as any).exprs ?? []) {
            walk(x);
          }
          break;
        case "sizeof_expr":
          walk(e.expr);
          break;
      }
    };
    walk(root);
  }

  // The root of an assignment target must be mutable: a get() accessor result is a read-only view (writing
  private checkAssignTarget(
    target: Expression,
    constParams: Set<string>,
    lookup: (name: string) => { const: boolean } | null,
  ): void {
    let root = target;
    while (root.kind === "member_access" || root.kind === "subscript") {
      root = root.kind === "member_access" ? root.object : root.object;
    }

    if (
      root.kind === "call" &&
      root.callee.kind === "member_access" &&
      root.callee.member === "get"
    ) {
      this.error(
        `cannot modify through get(): it returns a read-only view — use mut()`,
        target.span,
      );
      return;
    }

    if (root.kind === "identifier") {
      const local = lookup(root.name);
      if (local?.const) {
        this.error(`cannot assign to const '${root.name}'`, target.span);
      } else if (!local && constParams.has(root.name)) {
        this.error(`cannot assign to const parameter '${root.name}'`, target.span);
      }
    }
  }

  private isPublicFunctionContext(): boolean {
    if (this.currentFn?.name === "__impl_migrate") return false;
    const first = this.currentFn?.params[0]?.type;
    if (!first) return false;
    const t = unwrapType(first);
    return t.kind === "name" && t.name === "QpiContextFunctionCall";
  }

  private isAggregateType(type: TypeSpec): boolean {
    const t = unwrapType(type);
    return (
      t.kind === "inline_struct" ||
      t.kind === "array" ||
      t.kind === "template_instance" ||
      (t.kind === "name" && this.aggregateNames.has(t.name))
    );
  }

  private inferSimpleType(expr: Expression): TypeSpec | null {
    switch (expr.kind) {
      case "identifier":
        return this.currentTypes.get(expr.name) ?? null;
      case "int_literal":
        return { kind: "name", name: "uint64" };
      case "bool_literal":
        return { kind: "name", name: "bool" };
      case "char_literal":
        return { kind: "name", name: "int" };
      case "paren":
        return this.inferSimpleType(expr.expr);
      case "c_cast":
      case "static_cast":
      case "reinterpret_cast":
        return expr.type;
      case "construct":
        return expr.type;
      case "call": {
        const name = expr.callee.kind === "identifier" ? expr.callee.name : null;
        if (
          expr.callee.kind === "member_access" &&
          expr.callee.object.kind === "identifier" &&
          expr.callee.object.name === "state" &&
          (expr.callee.member === "get" || expr.callee.member === "mut")
        ) {
          return { kind: "name", name: "StateData" };
        }
        return name ? (this.currentMemberFns.get(name)?.decl.returnType ?? null) : null;
      }
      case "member_access": {
        const owner = this.inferSimpleType(expr.object);
        const concrete = owner ? unwrapType(owner) : null;
        return concrete?.kind === "name"
          ? (this.structFields.get(concrete.name)?.get(expr.member) ?? null)
          : null;
      }
      default:
        return null;
    }
  }

  private isReadonlyStateExpression(expr: Expression): boolean {
    let root = expr;
    while (root.kind === "member_access" || root.kind === "subscript") root = root.object;
    return (
      root.kind === "call" &&
      root.callee.kind === "member_access" &&
      root.callee.object.kind === "identifier" &&
      root.callee.object.name === "state" &&
      root.callee.member === "get"
    );
  }

  private isWritableReferenceArgument(
    arg: Expression,
    constParams: Set<string>,
    lookup: (name: string) => { const: boolean } | null,
  ): boolean {
    if (this.isReadonlyStateExpression(arg)) return false;
    if (arg.kind === "identifier") {
      const local = lookup(arg.name);
      if (local?.const || (!local && constParams.has(arg.name))) return false;
      return true;
    }
    return (
      arg.kind === "member_access" ||
      arg.kind === "subscript" ||
      (arg.kind === "unary_op" && arg.op === "*")
    );
  }

  // ---- Generic walkers ----

  private walkStatements(stmt: Statement, visit: (s: Statement) => void): void {
    visit(stmt);

    switch (stmt.kind) {
      case "compound":
        for (const s of stmt.body) {
          this.walkStatements(s, visit);
        }
        break;
      case "if":
        this.walkStatements(stmt.then, visit);
        if (stmt.else_) {
          this.walkStatements(stmt.else_, visit);
        }
        break;
      case "for":
        if (stmt.init) {
          this.walkStatements(stmt.init, visit);
        }
        this.walkStatements(stmt.body, visit);
        break;
      case "while":
      case "do_while":
      case "switch":
        this.walkStatements(stmt.body, visit);
        break;
    }
  }

  private walkExpressions(stmt: Statement, visit: (e: Expression) => void): void {
    const walkE = (e: Expression): void => {
      visit(e);
      switch (e.kind) {
        case "assign":
        case "binary_op":
          walkE(e.left);
          walkE(e.right);
          break;
        case "unary_op":
          walkE(e.arg);
          break;
        case "prefix_op":
        case "postfix_op":
          walkE(e.arg);
          break;
        case "ternary":
          walkE(e.cond);
          walkE(e.then);
          walkE(e.else_);
          break;
        case "member_access":
          walkE(e.object);
          break;
        case "subscript":
          walkE(e.object);
          walkE(e.index);
          break;
        case "call":
          walkE(e.callee);
          for (const a of e.args) {
            walkE(a);
          }
          break;
        case "template_call":
          for (const a of e.args) {
            walkE(a);
          }
          break;
        case "sequence":
          for (const x of e.exprs) {
            walkE(x);
          }
          break;
        case "c_cast":
        case "static_cast":
        case "reinterpret_cast":
          walkE(e.expr);
          break;
        case "construct":
        case "initializer_list":
          for (const x of (e as any).args ?? (e as any).exprs ?? []) {
            walkE(x);
          }
          break;
        case "sizeof_expr":
          walkE(e.expr);
          break;
      }
    };

    switch (stmt.kind) {
      case "expression":
        walkE(stmt.expr);
        break;
      case "declaration":
        if (stmt.decl.kind === "variable" && stmt.decl.init) {
          walkE(stmt.decl.init);
        }
        break;
      case "if":
        walkE(stmt.cond);
        break;
      case "for":
        if (stmt.cond) {
          walkE(stmt.cond);
        }
        if (stmt.update) {
          walkE(stmt.update);
        }
        break;
      case "while":
      case "do_while":
      case "switch":
        walkE(stmt.cond);
        break;
      case "return":
        if (stmt.value) {
          walkE(stmt.value);
        }
        break;
      case "case":
        walkE(stmt.value);
        break;
    }
  }
}

interface SupplementalFlowContext {
  loopDepth: number;
  switchDepth: number;
  runtimeNames: Set<string>;
  initialized: Set<string>;
  labels: Map<string, { span: any; initialized: Set<string> }>;
  gotos: Array<{ label: string; span: any; initialized: Set<string> }>;
}

function supplementalDiagnostic(message: string, span: any): ValidateDiagnostic {
  return { severity: "error", message, span };
}

function isModifiableLvalue(expr: any): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case "identifier":
    case "member_access":
    case "subscript":
      return true;
    case "paren":
      return isModifiableLvalue(expr.expr);
    case "unary_op":
      return expr.op === "*";
    default:
      return false;
  }
}

function isMutableReference(type: any): boolean {
  return type?.kind === "reference" && type.refereed?.kind !== "const";
}

function expressionUsesRuntimeName(expr: any, runtimeNames: Set<string>): boolean {
  if (!expr || typeof expr !== "object") return false;
  if (expr.kind === "identifier") return runtimeNames.has(expr.name);
  for (const [key, value] of Object.entries(expr)) {
    if (key === "span" || key === "kind") continue;
    if (Array.isArray(value)) {
      if (value.some((item) => expressionUsesRuntimeName(item, runtimeNames))) return true;
    } else if (
      value &&
      typeof value === "object" &&
      expressionUsesRuntimeName(value, runtimeNames)
    ) {
      return true;
    }
  }
  return false;
}

function validateSupplementalExpression(expr: any, diagnostics: ValidateDiagnostic[]): void {
  if (!expr || typeof expr !== "object") return;

  if (expr.kind === "assign" || (expr.kind === "binary_op" && expr.op === "=")) {
    if (!isModifiableLvalue(expr.left)) {
      diagnostics.push(
        supplementalDiagnostic(
          "assignment target is not a modifiable lvalue",
          expr.left?.span ?? expr.span,
        ),
      );
    }
  }
  if ((expr.kind === "prefix_op" || expr.kind === "postfix_op") && !isModifiableLvalue(expr.arg)) {
    diagnostics.push(
      supplementalDiagnostic(
        `operand of '${expr.op}' is not a modifiable lvalue`,
        expr.arg?.span ?? expr.span,
      ),
    );
  }

  for (const [key, value] of Object.entries(expr)) {
    if (key === "span" || key === "kind") continue;
    if (Array.isArray(value)) {
      for (const item of value) validateSupplementalExpression(item, diagnostics);
    } else if (value && typeof value === "object") {
      validateSupplementalExpression(value, diagnostics);
    }
  }
}

function validateSupplementalFunction(fn: any, diagnostics: ValidateDiagnostic[]): void {
  const params = fn.params ?? fn.fnParams ?? [];
  const context: SupplementalFlowContext = {
    loopDepth: 0,
    switchDepth: 0,
    runtimeNames: new Set(params.map((param: any) => param.name)),
    initialized: new Set(),
    labels: new Map(),
    gotos: [],
  };

  let sawDefault = false;
  for (const param of params) {
    if (param.defaultValue) sawDefault = true;
    else if (sawDefault) {
      diagnostics.push(
        supplementalDiagnostic(
          `parameter '${param.name}' without a default follows a parameter with a default`,
          param.span ?? fn.span,
        ),
      );
    }
  }

  const walk = (statement: any, current: SupplementalFlowContext): void => {
    if (!statement) return;
    switch (statement.kind) {
      case "compound": {
        const scoped: SupplementalFlowContext = {
          ...current,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        };
        for (const child of statement.body ?? []) walk(child, scoped);
        return;
      }
      case "declaration": {
        const declaration = statement.decl;
        if (declaration?.kind === "variable") {
          if (declaration.init) validateSupplementalExpression(declaration.init, diagnostics);
          if (
            isMutableReference(declaration.type) &&
            declaration.init &&
            !isModifiableLvalue(declaration.init)
          ) {
            diagnostics.push(
              supplementalDiagnostic(
                `mutable reference '${declaration.name}' cannot bind to a temporary`,
                declaration.init.span ?? declaration.span,
              ),
            );
          }
          if (!declaration.isConstexpr) current.runtimeNames.add(declaration.name);
          if (declaration.init)
            current.initialized.add(`${declaration.name}@${declaration.span?.start ?? 0}`);
        }
        return;
      }
      case "expression":
        validateSupplementalExpression(statement.expr, diagnostics);
        return;
      case "if":
        validateSupplementalExpression(statement.cond, diagnostics);
        walk(statement.then, {
          ...current,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        });
        if (statement.else_)
          walk(statement.else_, {
            ...current,
            runtimeNames: new Set(current.runtimeNames),
            initialized: new Set(current.initialized),
          });
        return;
      case "for": {
        const nested = {
          ...current,
          loopDepth: current.loopDepth + 1,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        };
        if (statement.init) walk(statement.init, nested);
        validateSupplementalExpression(statement.cond, diagnostics);
        validateSupplementalExpression(statement.update, diagnostics);
        walk(statement.body, nested);
        return;
      }
      case "while":
      case "do_while":
        validateSupplementalExpression(statement.cond, diagnostics);
        walk(statement.body, {
          ...current,
          loopDepth: current.loopDepth + 1,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        });
        return;
      case "switch":
        validateSupplementalExpression(statement.cond, diagnostics);
        walk(statement.body, {
          ...current,
          switchDepth: current.switchDepth + 1,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        });
        return;
      case "case":
        if (current.switchDepth === 0) {
          diagnostics.push(
            supplementalDiagnostic("case label is only valid inside a switch", statement.span),
          );
        } else if (expressionUsesRuntimeName(statement.value, current.runtimeNames)) {
          diagnostics.push(
            supplementalDiagnostic(
              "case label must be a constant expression",
              statement.value?.span ?? statement.span,
            ),
          );
        }
        validateSupplementalExpression(statement.value, diagnostics);
        return;
      case "default":
        if (current.switchDepth === 0) {
          diagnostics.push(
            supplementalDiagnostic("default label is only valid inside a switch", statement.span),
          );
        }
        return;
      case "break":
        if (current.loopDepth === 0 && current.switchDepth === 0) {
          diagnostics.push(
            supplementalDiagnostic("break is only valid inside a loop or switch", statement.span),
          );
        }
        return;
      case "goto":
        current.gotos.push({
          label: statement.label,
          span: statement.span,
          initialized: new Set(current.initialized),
        });
        return;
      case "label":
        if (current.labels.has(statement.name)) {
          diagnostics.push(
            supplementalDiagnostic(`duplicate label '${statement.name}'`, statement.span),
          );
        } else {
          current.labels.set(statement.name, {
            span: statement.span,
            initialized: new Set(current.initialized),
          });
        }
        return;
      case "return":
        validateSupplementalExpression(statement.value, diagnostics);
        return;
    }
  };

  if (fn.body) walk(fn.body, context);

  for (const jump of context.gotos) {
    const target = context.labels.get(jump.label);
    if (!target) {
      diagnostics.push(
        supplementalDiagnostic(`goto target '${jump.label}' is not defined`, jump.span),
      );
      continue;
    }
    if ([...target.initialized].some((declaration) => !jump.initialized.has(declaration))) {
      diagnostics.push(
        supplementalDiagnostic(
          `goto '${jump.label}' crosses an initialized declaration`,
          jump.span,
        ),
      );
    }
  }
}

function validateSupplementalDeclarations(
  declarations: any[],
  diagnostics: ValidateDiagnostic[],
): void {
  for (const declaration of declarations ?? []) {
    if (declaration.kind === "function" || declaration.kind === "function_template") {
      validateSupplementalFunction(declaration, diagnostics);
    }
    if (declaration.kind === "struct" || declaration.kind === "class_template") {
      validateSupplementalDeclarations(declaration.members, diagnostics);
    } else if (declaration.kind === "namespace" || declaration.kind === "extern_block") {
      validateSupplementalDeclarations(declaration.body, diagnostics);
    } else if (declaration.kind === "friend" && declaration.decl) {
      validateSupplementalDeclarations([declaration.decl], diagnostics);
    }
  }
}

export function validateAndDesugar(tu: { declarations: Declaration[] }): ValidateDiagnostic[] {
  const diagnostics = validateAndDesugarBase(tu);
  validateSupplementalDeclarations(tu.declarations, diagnostics);

  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.severity}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
