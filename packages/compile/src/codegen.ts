// WAT codegen: walks the parsed contract AST and emits a complete WASM-text module.
// Computes real struct field offsets (scalars, id/m256i, uint128, nested POD structs,
// Array<T,L>, BitArray<L>). Container types (HashMap/HashSet/Collection/LinkedList) are
// sized best-effort and flagged — their exact layout needs the real qpi.h template bodies.

import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, VariableDecl, TemplateParam } from "./ast";
import type { Sema } from "./sema";
import { emitModule, type UserEntry, type SysProcInfo, type ModuleSpec } from "./framework";

interface ClassTemplate {
  params: TemplateParam[];
  members: Declaration[];
}

export interface CodegenWarning {
  message: string;
  line: number;
}

interface FieldLayout {
  name: string;
  offset: number;
  size: number;
  type: TypeSpec;
}

interface StructLayout {
  size: number;
  fields: Map<string, FieldLayout>;
}

const SYSPROC_IMPL: Record<string, number> = {
  __impl_initialize: 0,
  __impl_beginEpoch: 1,
  __impl_endEpoch: 2,
  __impl_beginTick: 3,
  __impl_endTick: 4,
};

// Builtin scalar sizes
const SCALAR_SIZE: Record<string, number> = {
  bool: 1, bit: 1,
  sint8: 1, uint8: 1, "signed char": 1, "unsigned char": 1,
  sint16: 2, uint16: 2, "signed short": 2, "unsigned short": 2,
  sint32: 4, uint32: 4, "signed int": 4, "unsigned int": 4,
  sint64: 8, uint64: 8, "signed long long": 8, "unsigned long long": 8, "long long": 8,
  uint128: 16,
  id: 32, m256i: 32,
};

interface Bindings {
  types: Map<string, TypeSpec>;
  values: Map<string, bigint>;
  structs: Map<string, StructDecl>;   // nested structs visible in the current layout scope (e.g. HashMap::Element)
}

const NO_BIND: Bindings = { types: new Map(), values: new Map(), structs: new Map() };

class Codegen {
  private sema: Sema;
  private nested: Map<string, StructDecl> = new Map();          // contract-local nested structs
  templates: Map<string, ClassTemplate> = new Map();            // qpi.h templates (HashMap, Array, ...)
  globalStructs: Map<string, StructDecl> = new Map();           // qpi.h global/namespace structs
  typedefs: Map<string, TypeSpec> = new Map();                  // typedef aliases
  private layoutCache: Map<string, StructLayout> = new Map();
  warnings: CodegenWarning[] = [];

  constructor(sema: Sema) {
    this.sema = sema;
  }

  // ---- collect declarations from the whole TU (descends into namespaces) ----

  collectTU(decls: Declaration[]): void {
    for (const d of decls) {
      if (d.kind === "namespace") {
        this.collectTU((d as any).body);
      } else if (d.kind === "struct") {
        const s = d as StructDecl;
        if (s.name) this.globalStructs.set(s.name, s);
      } else if (d.kind === "class_template") {
        const ct = d as any;
        this.templates.set(ct.name, { params: ct.params, members: ct.members });
      } else if (d.kind === "typedef_decl") {
        const td = d as any;
        this.typedefs.set(td.name, td.type);
      }
    }
  }

  // ---- struct sizing (binding-aware: template params resolve through `b`) ----

  sizeOfType(t: TypeSpec, b: Bindings = NO_BIND): number {
    if (t.kind === "const") return this.sizeOfType(t.valueType, b);
    if (t.kind === "reference" || t.kind === "pointer") return 4;
    if (t.kind === "void") return 0;

    if (t.kind === "array") {
      const n = this.evalConst(t.size, b);
      return this.sizeOfType(t.elem, b) * n;
    }

    if (t.kind === "inline_struct") {
      return this.layoutOfStruct(t.struct, b).size;
    }

    if (t.kind === "name") {
      // template parameter bound to a concrete type?
      const bound = b.types.get(t.name);
      if (bound) return this.sizeOfType(bound, b);

      const s = SCALAR_SIZE[t.name];
      if (s !== undefined) return s;

      const td = this.typedefs.get(t.name);
      if (td) return this.sizeOfType(td, b);

      const struct = b.structs.get(t.name) ?? this.nested.get(t.name) ?? this.globalStructs.get(t.name);
      if (struct) return this.layoutOfStruct(struct, b).size;

      // an enum value type → 4 bytes; or numeric literal as a type arg
      const num = parseInt(t.name);
      if (!isNaN(num)) return num; // shouldn't happen for a type, defensive
      return 4; // assume enum-sized
    }

    if (t.kind === "template_instance") {
      return this.layoutOfTemplate(t.name, t.args, b).size;
    }

    return 0;
  }

  // Instantiate a template (HashMap<id,uint64,1024>, Array<T,L>, ...) and compute its exact layout
  // by substituting type args + non-type args into the captured member declarations.
  private layoutOfTemplate(name: string, args: TypeSpec[], parent: Bindings): StructLayout {
    const tmpl = this.templates.get(name);

    // Resolve args through the parent bindings (an arg may be a parent template param).
    const resolved = args.map((a) => this.resolveType(a, parent));

    if (!tmpl) {
      // Templates whose body we didn't capture: fall back to known formulas.
      return this.fallbackTemplateLayout(name, resolved, parent);
    }

    const b: Bindings = { types: new Map(), values: new Map(), structs: new Map() };
    for (let i = 0; i < tmpl.params.length; i++) {
      const p = tmpl.params[i];
      const arg = resolved[i];
      if (!arg) continue;
      if (p.kind === "type") {
        b.types.set(p.name, arg);
      } else {
        // non-type param (e.g. uint64 L) — evaluate the arg to an integer
        b.values.set(p.name, this.evalConstFromType(arg, parent));
      }
    }

    return this.layoutOfMembers(tmpl.members, b, `${name}<${resolved.map((r) => this.typeKey(r)).join(",")}>`);
  }

  // Add the struct declarations among `members` to a child binding scope so field types that
  // reference a sibling nested struct (e.g. HashMap::Element) resolve.
  private withLocalStructs(members: Declaration[], b: Bindings): Bindings {
    let structs = b.structs;
    for (const m of members) {
      if (m.kind === "struct" && (m as StructDecl).name) {
        if (structs === b.structs) structs = new Map(b.structs);
        structs.set((m as StructDecl).name, m as StructDecl);
      }
    }
    return structs === b.structs ? b : { types: b.types, values: b.values, structs };
  }

  private fallbackTemplateLayout(name: string, args: TypeSpec[], b: Bindings): StructLayout {
    const fields = new Map<string, FieldLayout>();
    let size = 0;
    if (name === "Array") {
      size = this.sizeOfType(args[0], b) * Number(this.evalConstFromType(args[1], b));
    } else if (name === "BitArray") {
      size = Math.ceil(Number(this.evalConstFromType(args[0], b)) / 64) * 8;
    } else {
      this.warn(`template '${name}<...>' not captured — size approximate`, 0);
      size = 8;
    }
    return { size, fields };
  }

  private resolveType(t: TypeSpec, b: Bindings): TypeSpec {
    if (t.kind === "name") {
      const bound = b.types.get(t.name);
      if (bound) return bound;
    }
    return t;
  }

  private evalConstFromType(t: TypeSpec, b: Bindings): bigint {
    // A non-type template arg arrives as a TypeSpec; recover its integer value.
    if (t.kind === "name") {
      const v = b.values.get(t.name);
      if (v !== undefined) return v;
      const n = parseInt(t.name);
      if (!isNaN(n)) return BigInt(n);
      const e = this.sema.evaluateConstexpr({ kind: "identifier", name: t.name, span: { start: 0, end: 0, line: 0, col: 0 } });
      if (e !== null) return e;
    }
    return 0n;
  }

  layoutOf(struct: StructDecl): StructLayout {
    return this.layoutOfStruct(struct, NO_BIND);
  }

  private layoutOfStruct(struct: StructDecl, b: Bindings): StructLayout {
    return this.layoutOfMembers(struct.members, b, struct.name, struct.isUnion);
  }

  private layoutOfMembers(members: Declaration[], bIn: Bindings, cacheKey: string, isUnion = false): StructLayout {
    const key = cacheKey && (bIn.types.size + bIn.values.size === 0) ? cacheKey : "";
    if (key) {
      const cached = this.layoutCache.get(key);
      if (cached) return cached;
    }

    // Make sibling nested structs (e.g. HashMap::Element) visible while sizing this scope's fields.
    const b = this.withLocalStructs(members, bIn);

    const fields = new Map<string, FieldLayout>();
    let offset = 0;
    let maxAlign = 1;

    if (isUnion) {
      let max = 0;
      for (const m of members) {
        if (m.kind === "variable") {
          const v = m as VariableDecl;
          if (v.isStatic || v.isConstexpr) continue;
          const sz = this.sizeOfType(v.type, b);
          fields.set(v.name, { name: v.name, offset: 0, size: sz, type: v.type });
          if (sz > max) max = sz;
        }
      }
      const layout = { size: max, fields };
      if (key) this.layoutCache.set(key, layout);
      return layout;
    }

    for (const m of members) {
      if (m.kind !== "variable") continue;
      const v = m as VariableDecl;
      if (v.isStatic || v.isConstexpr) continue;
      const sz = this.sizeOfType(v.type, b);
      const align = Math.min(this.alignOfTypeB(v.type, b), 8);
      offset = this.alignUp(offset, align);
      fields.set(v.name, { name: v.name, offset, size: sz, type: v.type });
      offset += sz;
      if (align > maxAlign) maxAlign = align;
    }

    const size = this.alignUp(offset, maxAlign);
    const layout = { size, fields };
    if (key) this.layoutCache.set(key, layout);
    return layout;
  }

  private alignOfTypeB(t: TypeSpec, b: Bindings): number {
    if (t.kind === "const") return this.alignOfTypeB(t.valueType, b);
    if (t.kind === "reference" || t.kind === "pointer") return 4;
    if (t.kind === "array") return this.alignOfTypeB(t.elem, b);
    if (t.kind === "inline_struct") return this.structAlign(t.struct.members, b);
    if (t.kind === "name") {
      const bound = b.types.get(t.name);
      if (bound) return this.alignOfTypeB(bound, b);
      const s = SCALAR_SIZE[t.name];
      if (s !== undefined) return Math.min(s, 8);
      const td = this.typedefs.get(t.name);
      if (td) return this.alignOfTypeB(td, b);
      const struct = this.nested.get(t.name) ?? this.globalStructs.get(t.name);
      if (struct) return this.structAlign(struct.members, b);
      return 4;
    }
    if (t.kind === "template_instance") {
      const tmpl = this.templates.get(t.name);
      if (tmpl) return this.structAlign(tmpl.members, b);
      if (t.name === "Array") return Math.min(this.alignOfTypeB(t.args[0], b), 8);
      return 8;
    }
    return 8;
  }

  private typeKey(t: TypeSpec): string {
    if (t.kind === "name") return t.name;
    if (t.kind === "template_instance") return `${t.name}<${t.args.map((a) => this.typeKey(a)).join(",")}>`;
    if (t.kind === "const") return "c" + this.typeKey(t.valueType);
    if (t.kind === "array") return `${this.typeKey(t.elem)}[]`;
    if (t.kind === "pointer") return "*";
    return "?";
  }

  private structAlign(members: Declaration[], b: Bindings): number {
    let a = 1;
    for (const m of members) {
      if (m.kind === "variable" && !(m as VariableDecl).isStatic && !(m as VariableDecl).isConstexpr) {
        a = Math.max(a, this.alignOfTypeB((m as VariableDecl).type, b));
      }
    }
    return Math.min(a, 8);
  }

  // Evaluate a constant expression, resolving template non-type params (e.g. L) through `b.values`.
  evalConst(expr: Expression, b: Bindings = NO_BIND): number {
    return Number(this.evalConstBig(expr, b));
  }

  private evalConstBig(expr: Expression, b: Bindings): bigint {
    switch (expr.kind) {
      case "int_literal": {
        const e = this.sema.evaluateConstexpr(expr);
        return e ?? 0n;
      }
      case "bool_literal": return expr.value ? 1n : 0n;
      case "char_literal": return BigInt(expr.value);
      case "paren": return this.evalConstBig(expr.expr, b);
      case "identifier": {
        const v = b.values.get(expr.name);
        if (v !== undefined) return v;
        const e = this.sema.evaluateConstexpr(expr);
        return e ?? 0n;
      }
      case "unary_op": {
        const a = this.evalConstBig(expr.arg, b);
        if (expr.op === "-") return -a;
        if (expr.op === "~") return ~a;
        if (expr.op === "!") return a === 0n ? 1n : 0n;
        return a;
      }
      case "binary_op": {
        const l = this.evalConstBig(expr.left, b);
        const r = this.evalConstBig(expr.right, b);
        switch (expr.op) {
          case "+": return l + r; case "-": return l - r; case "*": return l * r;
          case "/": return r === 0n ? 0n : l / r; case "%": return r === 0n ? 0n : l % r;
          case "<<": return l << r; case ">>": return l >> r;
          case "&": return l & r; case "|": return l | r; case "^": return l ^ r;
          case "<": return l < r ? 1n : 0n; case ">": return l > r ? 1n : 0n;
          case "<=": return l <= r ? 1n : 0n; case ">=": return l >= r ? 1n : 0n;
          case "==": return l === r ? 1n : 0n; case "!=": return l !== r ? 1n : 0n;
          default: return 0n;
        }
      }
      case "ternary":
        return this.evalConstBig(expr.cond, b) !== 0n ? this.evalConstBig(expr.then, b) : this.evalConstBig(expr.else_, b);
      case "sizeof_type":
        return BigInt(this.sizeOfType(expr.type, b));
      case "c_cast":
      case "static_cast":
        return this.evalConstBig(expr.expr, b);
      default:
        return 0n;
    }
  }

  private alignUp(n: number, a: number): number {
    return Math.ceil(n / a) * a;
  }

  // ---- collect nested structs ----

  collectNested(contract: StructDecl): void {
    for (const m of contract.members) {
      if (m.kind === "struct") {
        const s = m as StructDecl;
        this.nested.set(s.name, s);
      } else if (m.kind === "typedef_decl") {
        // typedef X Y — alias; resolve later via sizeOfType fallback
      }
    }
  }

  warn(message: string, line: number): void {
    this.warnings.push({ message, line });
  }
}

// ---- entry point ----

export interface LibTypes {
  templates: Map<string, ClassTemplate>;
  globalStructs: Map<string, StructDecl>;
  typedefs: Map<string, TypeSpec>;
}

// Parse-once: collect the qpi.h library type table (templates/structs/typedefs) from its AST.
export function buildLibTypes(decls: Declaration[]): LibTypes {
  const cg = new Codegen({} as Sema);
  cg.collectTU(decls);
  return { templates: cg.templates, globalStructs: cg.globalStructs, typedefs: cg.typedefs };
}

export function generateWasmModule(
  tu: { declarations: Declaration[] },
  sema: Sema,
  contractName: string,
  slot: number,
  arenaSz: number = 1024 * 1024 * 1024,
  lib?: LibTypes,
): string {
  const cg = new Codegen(sema);

  // Seed the qpi.h library type table (templates / structs / typedefs) parsed once, then add
  // the user contract's own declarations on top.
  if (lib) {
    for (const [k, v] of lib.templates) cg.templates.set(k, v);
    for (const [k, v] of lib.globalStructs) cg.globalStructs.set(k, v);
    for (const [k, v] of lib.typedefs) cg.typedefs.set(k, v);
  }
  cg.collectTU(tu.declarations);

  const contract = findContractStruct(tu);
  if (!contract) {
    return emitModule({ stateSize: 0, arenaSize: arenaSz, entries: [], sysprocs: [], userFunctionsWat: ";; no contract struct found" });
  }

  cg.collectNested(contract);

  // state size from StateData
  const stateData = cg["nested"].get("StateData");
  const stateLayout = stateData ? cg.layoutOf(stateData) : { size: 0, fields: new Map() };
  const stateSize = stateLayout.size;

  // registrations → entries
  const regs = extractRegistrations(contract);
  const entries: UserEntry[] = [];
  const userFns: string[] = [];

  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i];
    const fn = findMemberFn(contract, reg.fnName);
    const inStruct = cg["nested"].get(`${reg.fnName}_input`);
    const outStruct = cg["nested"].get(`${reg.fnName}_output`);
    const localsStruct = cg["nested"].get(`${reg.fnName}_locals`);
    const inLayout = inStruct ? cg.layoutOf(inStruct) : { size: 0, fields: new Map() };
    const outLayout = outStruct ? cg.layoutOf(outStruct) : { size: 0, fields: new Map() };
    const localsLayout = localsStruct ? cg.layoutOf(localsStruct) : { size: 0, fields: new Map() };

    const label = `$user_${i}`;
    userFns.push(emitFunction(cg, label, fn, stateLayout, inLayout, outLayout, localsLayout));

    entries.push({
      inputType: reg.inputType,
      kind: reg.kind,
      inSize: inLayout.size,
      outSize: outLayout.size,
      localsSize: localsLayout.size,
      label,
    });
  }

  // system procedures
  const sysprocs: SysProcInfo[] = [];
  let sysIdx = 0;
  for (const m of contract.members) {
    if (m.kind === "function") {
      const fn = m as FunctionDecl;
      const spId = SYSPROC_IMPL[fn.name];
      if (spId !== undefined) {
        const label = `$sys_${sysIdx++}`;
        userFns.push(emitFunction(cg, label, fn, stateLayout, { size: 0, fields: new Map() }, { size: 0, fields: new Map() }, { size: 0, fields: new Map() }));
        sysprocs.push({ id: spId, localsSize: 0, inSize: 0, outSize: 0, label });
      }
    }
  }

  const spec: ModuleSpec = {
    stateSize,
    arenaSize: arenaSz,
    entries,
    sysprocs,
    userFunctionsWat: userFns.join("\n"),
  };

  // expose warnings via a side channel (sema diagnostics)
  for (const w of cg.warnings) {
    sema.warn(w.message, { start: 0, end: 0, line: w.line, col: 0 });
  }

  return emitModule(spec);
}

// ---- AST helpers ----

function findContractStruct(tu: { declarations: Declaration[] }): StructDecl | null {
  // The user contract may end up nested inside a namespace if qpi.h's bracket structure recovered
  // imperfectly, so search recursively. Prefer a struct that inherits ContractBase.
  const all: StructDecl[] = [];
  const walk = (decls: Declaration[]) => {
    for (const d of decls) {
      if (d.kind === "struct") all.push(d as StructDecl);
      else if (d.kind === "namespace") walk((d as any).body);
    }
  };
  walk(tu.declarations);

  for (const s of all) {
    if (s.bases.some((b) => b.kind === "name" && b.name === "ContractBase")) return s;
    if (s.name === "CONTRACT_STATE_TYPE") return s;
  }
  // fallback: a struct with a nested StateData that isn't one of the qpi.h library types
  for (const s of all) {
    if (s.members.some((m) => m.kind === "struct" && (m as StructDecl).name === "StateData")) return s;
  }
  return null;
}

interface RegEntry {
  fnName: string;
  kind: number;
  inputType: number;
}

function extractRegistrations(contract: StructDecl): RegEntry[] {
  const regs: RegEntry[] = [];
  const regFn = contract.members.find(
    (m) => m.kind === "function" && (m as FunctionDecl).name === "__registerUserFunctionsAndProcedures",
  ) as FunctionDecl | undefined;

  if (!regFn?.body || regFn.body.kind !== "compound") return regs;

  for (const stmt of regFn.body.body) {
    if (stmt.kind !== "expression") continue;
    const e = stmt.expr;
    if (e.kind !== "call") continue;
    if (e.callee.kind !== "member_access") continue;
    const method = e.callee.member;
    const isFn = method === "__registerUserFunction";
    const isProc = method === "__registerUserProcedure";
    if (!isFn && !isProc) continue;

    // args: (void*)fnName, inputType, sizeof(...), ...
    const fnArg = e.args[0];
    let fnName = "";
    if (fnArg?.kind === "c_cast" && fnArg.expr.kind === "identifier") fnName = fnArg.expr.name;
    else if (fnArg?.kind === "identifier") fnName = fnArg.name;

    const itArg = e.args[1];
    let inputType = 0;
    if (itArg?.kind === "int_literal") inputType = parseInt(itArg.value);

    if (fnName && inputType >= 1) {
      regs.push({ fnName, kind: isFn ? 0 : 1, inputType });
    }
  }

  return regs;
}

function findMemberFn(contract: StructDecl, name: string): FunctionDecl | null {
  for (const m of contract.members) {
    if (m.kind === "function" && (m as FunctionDecl).name === name) return m as FunctionDecl;
  }
  return null;
}

// ---- function body codegen ----

interface FnCtx {
  cg: Codegen;
  state: StructLayout;
  in: StructLayout;
  out: StructLayout;
  locals: StructLayout;
  localVars: Map<string, { wasmType: "i32" | "i64" }>;
  lines: string[];
}

function emitFunction(
  cg: Codegen,
  label: string,
  fn: FunctionDecl | null,
  state: StructLayout,
  inL: StructLayout,
  outL: StructLayout,
  localsL: StructLayout,
): string {
  const ctx: FnCtx = { cg, state, in: inL, out: outL, locals: localsL, localVars: new Map(), lines: [] };

  // Pre-scan for local variable declarations (must be declared at function top in WAT)
  if (fn?.body) collectLocals(fn.body, ctx);

  const header = `  (func ${label} (param $ctx i32) (param $state i32) (param $in i32) (param $out i32) (param $locals i32)`;
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);

  if (fn?.body) {
    emitStmt(ctx, fn.body);
  }

  return [header, ...localDecls, ...ctx.lines, "  )"].join("\n");
}

function collectLocals(stmt: Statement, ctx: FnCtx): void {
  switch (stmt.kind) {
    case "compound":
      for (const s of stmt.body) collectLocals(s, ctx);
      break;
    case "if":
      collectLocals(stmt.then, ctx);
      if (stmt.else_) collectLocals(stmt.else_, ctx);
      break;
    case "for":
      if (stmt.init) collectLocals(stmt.init, ctx);
      collectLocals(stmt.body, ctx);
      break;
    case "while":
      collectLocals(stmt.body, ctx);
      break;
    case "do_while":
      collectLocals(stmt.body, ctx);
      break;
    case "switch":
      collectLocals(stmt.body, ctx);
      break;
    case "declaration": {
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        const sz = ctx.cg.sizeOfType(v.type);
        // integers/scalars → i64 value model; pointers/structs → i32 (address) but we only handle scalars
        const wasmType: "i32" | "i64" = "i64";
        if (!ctx.localVars.has(v.name)) ctx.localVars.set(v.name, { wasmType });
      }
      break;
    }
  }
}

function emitStmt(ctx: FnCtx, stmt: Statement): void {
  switch (stmt.kind) {
    case "compound":
      for (const s of stmt.body) emitStmt(ctx, s);
      break;

    case "expression": {
      const w = emitExprDrop(ctx, stmt.expr);
      if (w) ctx.lines.push(`    ${w}`);
      break;
    }

    case "declaration": {
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        if (v.init) {
          const val = emitValue(ctx, v.init);
          ctx.lines.push(`    (local.set $${v.name} ${val})`);
        }
      }
      break;
    }

    case "if": {
      const cond = emitValue(ctx, stmt.cond);
      ctx.lines.push(`    (if (i32.ne (i32.const 0) (i32.wrap_i64 ${cond})) (then`);
      emitStmt(ctx, stmt.then);
      if (stmt.else_) {
        ctx.lines.push(`    ) (else`);
        emitStmt(ctx, stmt.else_);
      }
      ctx.lines.push(`    ))`);
      break;
    }

    case "for": {
      if (stmt.init) emitStmt(ctx, stmt.init);
      ctx.lines.push(`    (block $brk (loop $cont`);
      if (stmt.cond) {
        ctx.lines.push(`      (br_if $brk (i32.eqz (i32.wrap_i64 ${emitValue(ctx, stmt.cond)})))`);
      }
      emitStmt(ctx, stmt.body);
      if (stmt.update) {
        const u = emitExprDrop(ctx, stmt.update);
        if (u) ctx.lines.push(`      ${u}`);
      }
      ctx.lines.push(`      (br $cont)))`);
      break;
    }

    case "while": {
      ctx.lines.push(`    (block $brk (loop $cont`);
      ctx.lines.push(`      (br_if $brk (i32.eqz (i32.wrap_i64 ${emitValue(ctx, stmt.cond)})))`);
      emitStmt(ctx, stmt.body);
      ctx.lines.push(`      (br $cont)))`);
      break;
    }

    case "return":
      ctx.lines.push(`    (return)`);
      break;

    case "static_assert":
    case "empty":
    case "label":
      break;

    default:
      ctx.cg.warn(`unsupported statement '${stmt.kind}'`, stmt.span.line);
      break;
  }
}

// Emit an expression used as a statement (side effects only). Returns WAT or "".
function emitExprDrop(ctx: FnCtx, expr: Expression): string {
  if (expr.kind === "assign") {
    return emitAssign(ctx, expr);
  }
  if (expr.kind === "call") {
    // a bare call — emit it, drop any result
    const callWat = emitCall(ctx, expr);
    const sig = callWat.startsWith("(call $qpi_") || callWat.startsWith("(call $lite");
    // If the called forwarder returns a value, drop it. Heuristic: wrap in drop if it's a value-returning qpi.
    return wrapDropIfValue(callWat);
  }
  if (expr.kind === "postfix_op" || expr.kind === "prefix_op") {
    // e.g., i++ on a local
    return emitIncDec(ctx, expr);
  }
  return "";
}

function wrapDropIfValue(callWat: string): string {
  // Empty / comment-only / void-returning forwarders leave nothing on the stack — never drop those.
  const trimmed = callWat.trim();
  if (!trimmed || trimmed.startsWith(";;")) return "";

  const voidCalls = ["$qpi_now", "$qpi_invocator", "$qpi_originator", "$qpi_nextId", "$qpi_prevId",
    "$qpi_arbitrator", "$qpi_computor", "$qpi_k12", "$qpi_abort", "$qpi_markDirty", "$qpi_logBytes",
    "$qpi_initMiningSeed", "$qpi_computeMiningFunction", "$qpi_ipoBidId", "$qpi_transferTyped",
    "$qpi_prevSpectrumDigest", "$qpi_prevUniverseDigest", "$qpi_prevComputerDigest"];
  for (const vc of voidCalls) {
    if (callWat.startsWith(`(call ${vc} `) || callWat.startsWith(`(call ${vc})`)) return callWat;
  }
  // Only emit a drop when there is genuinely a value-producing call expression.
  if (trimmed.startsWith("(call ")) return `(drop ${callWat})`;
  return "";
}

function emitIncDec(ctx: FnCtx, expr: Expression): string {
  const arg = expr.kind === "postfix_op" || expr.kind === "prefix_op" ? expr.arg : expr;
  const op = (expr as any).op === "++" ? "i64.add" : "i64.sub";
  // Only handle local var or member lvalue
  const addr = tryLvalueAddr(ctx, arg);
  if (addr) {
    const load = loadAt(addr.addr, addr.size);
    const stored = `(${op} ${load} (i64.const 1))`;
    return storeAt(addr.addr, addr.size, stored);
  }
  if (arg.kind === "identifier" && ctx.localVars.has(arg.name)) {
    return `(local.set $${arg.name} (${op} (local.get $${arg.name}) (i64.const 1)))`;
  }
  return "";
}

// ---- lvalue addressing ----

interface Lvalue {
  addr: string;   // WAT producing the i32 byte address
  size: number;   // field size in bytes
}

function tryLvalueAddr(ctx: FnCtx, expr: Expression): Lvalue | null {
  if (expr.kind !== "member_access") return null;
  const ma = expr;
  const obj = ma.object;

  // output.field / input.field / locals.field
  if (obj.kind === "identifier") {
    const layouts: Record<string, { ptr: string; layout: StructLayout }> = {
      output: { ptr: "(local.get $out)", layout: ctx.out },
      input: { ptr: "(local.get $in)", layout: ctx.in },
      locals: { ptr: "(local.get $locals)", layout: ctx.locals },
    };
    const sel = layouts[obj.name];
    if (sel) {
      const f = sel.layout.fields.get(ma.member);
      if (f) return { addr: addrOf(sel.ptr, f.offset), size: f.size };
      return null;
    }
  }

  // state.mut().field / state.get().field
  if (obj.kind === "call" && obj.callee.kind === "member_access") {
    const inner = obj.callee;
    if (inner.object.kind === "identifier" && inner.object.name === "state" &&
      (inner.member === "mut" || inner.member === "get")) {
      const f = ctx.state.fields.get(ma.member);
      if (f) return { addr: addrOf("(local.get $state)", f.offset), size: f.size };
      return null;
    }
  }

  return null;
}

function addrOf(ptr: string, offset: number): string {
  if (offset === 0) return ptr;
  return `(i32.add ${ptr} (i32.const ${offset}))`;
}

function loadAt(addr: string, size: number): string {
  switch (size) {
    case 8: return `(i64.load ${addr})`;
    case 4: return `(i64.extend_i32_u (i32.load ${addr}))`;
    case 2: return `(i64.extend_i32_u (i32.load16_u ${addr}))`;
    case 1: return `(i64.extend_i32_u (i32.load8_u ${addr}))`;
    default: return `(i64.load ${addr})`;
  }
}

function storeAt(addr: string, size: number, value: string): string {
  switch (size) {
    case 8: return `(i64.store ${addr} ${value})`;
    case 4: return `(i32.store ${addr} (i32.wrap_i64 ${value}))`;
    case 2: return `(i32.store16 ${addr} (i32.wrap_i64 ${value}))`;
    case 1: return `(i32.store8 ${addr} (i32.wrap_i64 ${value}))`;
    default: return `(i64.store ${addr} ${value})`;
  }
}

// ---- assignment ----

function emitAssign(ctx: FnCtx, expr: Expression & { kind: "assign" }): string {
  const lv = tryLvalueAddr(ctx, expr.left);
  const rhs = emitValue(ctx, expr.right);

  if (lv) {
    if (expr.op === "=") {
      return storeAt(lv.addr, lv.size, rhs);
    }
    const load = loadAt(lv.addr, lv.size);
    const op = compoundOp(expr.op);
    return storeAt(lv.addr, lv.size, `(${op} ${load} ${rhs})`);
  }

  // local variable assignment
  if (expr.left.kind === "identifier" && ctx.localVars.has(expr.left.name)) {
    const n = expr.left.name;
    if (expr.op === "=") return `(local.set $${n} ${rhs})`;
    const op = compoundOp(expr.op);
    return `(local.set $${n} (${op} (local.get $${n}) ${rhs}))`;
  }

  ctx.cg.warn(`unsupported assignment target`, expr.span.line);
  return "";
}

function compoundOp(op: string): string {
  switch (op) {
    case "+=": return "i64.add";
    case "-=": return "i64.sub";
    case "*=": return "i64.mul";
    case "/=": return "i64.div_s";
    case "%=": return "i64.rem_s";
    case "&=": return "i64.and";
    case "|=": return "i64.or";
    case "^=": return "i64.xor";
    case "<<=": return "i64.shl";
    case ">>=": return "i64.shr_u";
    default: return "i64.add";
  }
}

// ---- value (rvalue) codegen — produces an i64 ----

function emitValue(ctx: FnCtx, expr: Expression): string {
  switch (expr.kind) {
    case "int_literal": {
      const v = ctx.cg["sema"].evaluateConstexpr(expr) ?? 0n;
      return `(i64.const ${v})`;
    }
    case "bool_literal":
      return `(i64.const ${expr.value ? 1 : 0})`;
    case "char_literal":
      return `(i64.const ${expr.value})`;
    case "paren":
      return emitValue(ctx, expr.expr);
    case "identifier": {
      if (ctx.localVars.has(expr.name)) return `(local.get $${expr.name})`;
      // a constexpr / enum value
      const e = ctx.cg["sema"].evaluateConstexpr(expr);
      if (e !== null) return `(i64.const ${e})`;
      ctx.cg.warn(`unknown identifier '${expr.name}'`, expr.span.line);
      return `(i64.const 0)`;
    }
    case "member_access": {
      const lv = tryLvalueAddr(ctx, expr);
      if (lv) return loadAt(lv.addr, lv.size);
      // qpi.invocationReward() etc. handled in call; bare member returns 0
      ctx.cg.warn(`unsupported member read`, expr.span.line);
      return `(i64.const 0)`;
    }
    case "call":
      return emitCallValue(ctx, expr);
    case "binary_op":
      return emitBinary(ctx, expr);
    case "unary_op": {
      const a = emitValue(ctx, expr.arg);
      switch (expr.op) {
        case "-": return `(i64.sub (i64.const 0) ${a})`;
        case "~": return `(i64.xor ${a} (i64.const -1))`;
        case "!": return `(i64.extend_i32_u (i64.eqz ${a}))`;
        default: return a;
      }
    }
    case "ternary":
      return `(select ${emitValue(ctx, expr.then)} ${emitValue(ctx, expr.else_)} (i32.wrap_i64 ${emitValue(ctx, expr.cond)}))`;
    case "c_cast":
    case "static_cast":
      return emitValue(ctx, expr.expr);
    case "sizeof_type":
      return `(i64.const ${ctx.cg.sizeOfType(expr.type)})`;
    default:
      ctx.cg.warn(`unsupported expression '${expr.kind}' as value`, (expr as any).span?.line ?? 0);
      return `(i64.const 0)`;
  }
}

function emitBinary(ctx: FnCtx, expr: Expression & { kind: "binary_op" }): string {
  const l = emitValue(ctx, expr.left);
  const r = emitValue(ctx, expr.right);
  const cmp = (op: string) => `(i64.extend_i32_u (${op} ${l} ${r}))`;
  switch (expr.op) {
    case "+": return `(i64.add ${l} ${r})`;
    case "-": return `(i64.sub ${l} ${r})`;
    case "*": return `(i64.mul ${l} ${r})`;
    case "/": return `(i64.div_s ${l} ${r})`;
    case "%": return `(i64.rem_s ${l} ${r})`;
    case "<<": return `(i64.shl ${l} ${r})`;
    case ">>": return `(i64.shr_u ${l} ${r})`;
    case "&": return `(i64.and ${l} ${r})`;
    case "|": return `(i64.or ${l} ${r})`;
    case "^": return `(i64.xor ${l} ${r})`;
    case "==": return cmp("i64.eq");
    case "!=": return cmp("i64.ne");
    case "<": return cmp("i64.lt_s");
    case ">": return cmp("i64.gt_s");
    case "<=": return cmp("i64.le_s");
    case ">=": return cmp("i64.ge_s");
    case "&&": return `(i64.extend_i32_u (i32.and (i64.ne (i64.const 0) ${l}) (i64.ne (i64.const 0) ${r})))`;
    case "||": return `(i64.extend_i32_u (i32.or (i64.ne (i64.const 0) ${l}) (i64.ne (i64.const 0) ${r})))`;
    default: return `(i64.const 0)`;
  }
}

// qpi.* method name → forwarder + whether it returns i64/i32/void
const QPI_METHODS: Record<string, { fwd: string; ret: "i64" | "i32" | "void" }> = {
  invocationReward: { fwd: "$qpi_invocationReward", ret: "i64" },
  epoch: { fwd: "$qpi_epoch", ret: "i32" },
  tick: { fwd: "$qpi_tick", ret: "i32" },
  numberOfTickTransactions: { fwd: "$qpi_numberOfTickTransactions", ret: "i32" },
  day: { fwd: "$qpi_day", ret: "i32" },
  year: { fwd: "$qpi_year", ret: "i32" },
  hour: { fwd: "$qpi_hour", ret: "i32" },
  minute: { fwd: "$qpi_minute", ret: "i32" },
  month: { fwd: "$qpi_month", ret: "i32" },
  second: { fwd: "$qpi_second", ret: "i32" },
  millisecond: { fwd: "$qpi_millisecond", ret: "i32" },
  contractIndex: { fwd: "$qpi_contractIndex", ret: "i32" },
};

function emitCallValue(ctx: FnCtx, expr: Expression & { kind: "call" }): string {
  // qpi.method(args) returning a value
  if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const m = QPI_METHODS[expr.callee.member];
    if (m) {
      if (m.ret === "i64") return `(call ${m.fwd})`;
      if (m.ret === "i32") return `(i64.extend_i32_u (call ${m.fwd}))`;
    }
  }
  ctx.cg.warn(`unsupported call as value`, expr.span.line);
  return `(i64.const 0)`;
}

function emitCall(ctx: FnCtx, expr: Expression & { kind: "call" }): string {
  // qpi.method(args) as a statement (side-effecting)
  if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const method = expr.callee.member;
    // transfer/burn etc. — emit forwarder with arg addresses/values (best-effort)
    if (method === "burn") {
      const amt = expr.args[0] ? emitValue(ctx, expr.args[0]) : "(i64.const 0)";
      return `(call $qpi_burn ${amt} (i32.const 0))`;
    }
    // markDirty implicitly handled; other void qpi calls: emit nothing meaningful
    ctx.cg.warn(`qpi.${method}() not fully supported in local compiler`, expr.span.line);
    return `(call $qpi_markDirty (call $qpi_contractIndex))`;
  }
  ctx.cg.warn(`unsupported call statement`, expr.span.line);
  return "";
}
