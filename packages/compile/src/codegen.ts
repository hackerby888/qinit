// WAT codegen: walks the parsed contract AST and emits a complete WASM-text module.
// Computes real struct field offsets (scalars, id/m256i, uint128, nested POD structs,
// Array<T,L>, BitArray<L>). Container types (HashMap/HashSet/Collection/LinkedList) are
// sized best-effort and flagged — their exact layout needs the real qpi.h template bodies.

import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "./ast";
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
  align: number;
  fields: Map<string, FieldLayout>;
}

const SYSPROC_IMPL: Record<string, number> = {
  __impl_initialize: 0,
  __impl_beginEpoch: 1,
  __impl_endEpoch: 2,
  __impl_beginTick: 3,
  __impl_endTick: 4,
};

// The scaffold renames a lifecycle procedure to its __impl_* name, but its locals struct keeps the macro
// spelling (END_EPOCH_locals, ...). Map the impl name back so the right locals frame is found.
const SYSPROC_LOCALS_PREFIX: Record<string, string> = {
  __impl_initialize: "INITIALIZE",
  __impl_beginEpoch: "BEGIN_EPOCH",
  __impl_endEpoch: "END_EPOCH",
  __impl_beginTick: "BEGIN_TICK",
  __impl_endTick: "END_TICK",
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
  auto: 8,   // `auto` locals in qpi.h bodies are integer counters (pointer cases carry a trailing *)
};

interface Bindings {
  types: Map<string, TypeSpec>;
  values: Map<string, bigint>;
  structs: Map<string, StructDecl>;   // nested structs visible in the current layout scope (e.g. HashMap::Element)
}

const NO_BIND: Bindings = { types: new Map(), values: new Map(), structs: new Map() };

// Callee contract IDL for inter-contract calls — name → contract index + per-entry input type / IO sizes.
export interface CalleeIdl {
  name: string;
  index: number;
  functions: Record<string, { inputType: number; inSize: number; outSize: number }>;
  procedures: Record<string, { inputType: number; inSize: number; outSize: number }>;
}

class Codegen {
  private sema: Sema;
  private nested: Map<string, StructDecl> = new Map();          // contract-local nested structs
  templates: Map<string, ClassTemplate> = new Map();            // qpi.h templates (HashMap, Array, ...)
  globalStructs: Map<string, StructDecl> = new Map();           // qpi.h global/namespace structs
  typedefs: Map<string, TypeSpec> = new Map();                  // typedef aliases
  constexprInit: Map<string, Expression> = new Map();           // named constexpr → its init expression
  enumConst: Map<string, bigint> = new Map();                   // enum constant (NAME and Type::NAME) → value
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>> = new Map();  // Class → method → out-of-class def
  compiledMethods: Map<string, CompiledMethod> = new Map();     // instantiation cache key → compiled method
  emittedMethodOrder: string[] = [];                            // emitted WAT, in emission order (appended to module)
  private constCache: Map<string, bigint> = new Map();
  private constInProgress = new Set<string>();
  helpers: Map<string, HelperInfo> = new Map();    // value helpers: toReturnCode(...) etc.
  privates: Map<string, PrivateInfo> = new Map();   // PRIVATE_FUNCTION/PROCEDURE called via CALL()
  callees: Map<string, CalleeIdl> = new Map();      // other contracts callable via CALL_OTHER/INVOKE_OTHER (by state-type name)
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
        // file-scope structs can still nest constants/enums (e.g. a contract's static constexpr)
        this.collectConstants(s.members);
      } else if (d.kind === "class_template") {
        const ct = d as any;
        this.templates.set(ct.name, { params: ct.params, members: ct.members });
        // Inline member methods defined with a body in the class itself (e.g. capacity()) are captured
        // as template methods, so they compile through the same per-type instantiation path as the
        // out-of-class (impl) definitions. Body-less declarations are skipped — their bodies live in
        // the impl chunk and are merged separately.
        for (const m of ct.members) {
          if (m.kind !== "function" || !(m as FunctionDecl).body) continue;
          const fn = m as FunctionDecl;
          if (!this.templateMethods.has(ct.name)) this.templateMethods.set(ct.name, new Map());
          const into = this.templateMethods.get(ct.name)!;
          if (into.has(fn.name)) continue;
          into.set(fn.name, {
            kind: "function_template",
            name: fn.name,
            params: ct.params,
            fnParams: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            isConstexpr: fn.isConstexpr,
            span: fn.span,
          });
        }
      } else if (d.kind === "function_template" || d.kind === "function") {
        // out-of-class template method definition: HashMap::set, Collection::add, ...
        const fn = d as FunctionTemplateDecl;
        const sep = fn.name.indexOf("::");
        if (sep > 0 && fn.body) {
          const cls = fn.name.slice(0, sep);
          const method = fn.name.slice(sep + 2);
          if (!this.templateMethods.has(cls)) this.templateMethods.set(cls, new Map());
          // first definition wins (skip explicit specializations like HashFunction<m256i>)
          if (!this.templateMethods.get(cls)!.has(method)) this.templateMethods.get(cls)!.set(method, fn);
        }
      } else if (d.kind === "typedef_decl") {
        const td = d as any;
        this.typedefs.set(td.name, td.type);
      } else if (d.kind === "variable") {
        this.collectConstant(d as VariableDecl);
      } else if (d.kind === "enum") {
        this.collectEnum(d as any);
      }
    }
  }

  // Collect named constexpr/const-with-initializer values and enum constants from a member list.
  private collectConstants(members: Declaration[]): void {
    for (const m of members) {
      if (m.kind === "variable") this.collectConstant(m as VariableDecl);
      else if (m.kind === "enum") this.collectEnum(m as any);
    }
  }

  private collectConstant(v: VariableDecl): void {
    if (v.init && (v.isConstexpr || v.type.kind === "const")) {
      if (!this.constexprInit.has(v.name)) this.constexprInit.set(v.name, v.init);
    }
  }

  private collectEnum(e: { name?: string; members: { name: string; value?: Expression }[] }): void {
    let next = 0n;
    for (const m of e.members) {
      const v = m.value ? this.evalConstBig(m.value, NO_BIND) : next;
      next = v + 1n;
      if (!this.enumConst.has(m.name)) this.enumConst.set(m.name, v);
      if (e.name) this.enumConst.set(`${e.name}::${m.name}`, v);
    }
  }

  // Resolve a named constant (enum constant or constexpr) to its integer value, or null if unknown.
  resolveConst(name: string): bigint | null {
    const cached = this.constCache.get(name);
    if (cached !== undefined) return cached;
    const en = this.enumConst.get(name);
    if (en !== undefined) {
      this.constCache.set(name, en);
      return en;
    }
    const init = this.constexprInit.get(name);
    if (init === undefined) return null;
    if (this.constInProgress.has(name)) return null;   // cyclic constexpr — give up
    this.constInProgress.add(name);
    try {
      const v = this.evalConstBig(init, NO_BIND);
      this.constCache.set(name, v);
      return v;
    } finally {
      this.constInProgress.delete(name);
    }
  }

  // ---- struct sizing (binding-aware: template params resolve through `b`) ----

  private sizeDepth = 0;

  sizeOfType(t: TypeSpec, b: Bindings = NO_BIND): number {
    // Guard against recursive/self-referential types (a struct reachable from its own field).
    if (this.sizeDepth > 80) {
      this.warn("type nesting too deep / recursive — sized as 0", 0);
      return 0;
    }
    this.sizeDepth++;
    try {
      return this.sizeOfTypeInner(t, b);
    } finally {
      this.sizeDepth--;
    }
  }

  private sizeOfTypeInner(t: TypeSpec, b: Bindings): number {
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
    return { size, align: 1, fields };
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
    if (t.kind === "expr_value") return this.evalConstBig(t.expr, b);
    if (t.kind === "name") {
      const v = b.values.get(t.name);
      if (v !== undefined) return v;
      const n = parseInt(t.name);
      if (!isNaN(n)) return BigInt(n);
      // a named constant template arg (e.g. Array<RoundInfo, QEARN_MAX_EPOCHS>)
      const c = this.resolveConst(t.name);
      if (c !== null) return c;
      if (this.sema && typeof this.sema.evaluateConstexpr === "function") {
        const e = this.sema.evaluateConstexpr({ kind: "identifier", name: t.name, span: { start: 0, end: 0, line: 0, col: 0 } });
        if (e !== null) return e;
      }
    }
    return 0n;
  }

  layoutOf(struct: StructDecl): StructLayout {
    return this.layoutOfStruct(struct, NO_BIND);
  }

  private layoutOfStruct(struct: StructDecl, b: Bindings): StructLayout {
    return this.layoutOfMembers(struct.members, b, struct.name, struct.isUnion);
  }

  private inProgress = new Set<string>();

  private bindingSig(b: Bindings): string {
    if (b.types.size + b.values.size === 0) return "";
    const ts = [...b.types].map(([k, v]) => `${k}=${this.typeKey(v)}`).join(",");
    const vs = [...b.values].map(([k, v]) => `${k}=${v}`).join(",");
    return `|${ts}|${vs}`;
  }

  private layoutOfMembers(members: Declaration[], bIn: Bindings, cacheKey: string, isUnion = false): StructLayout {
    // Cache by a binding-aware key so each concrete instantiation is computed once (avoids the
    // exponential blowup of deeply nested templates like Array<HashMap<...>, N>).
    const key = cacheKey ? cacheKey + this.bindingSig(bIn) : "";
    if (key) {
      const cached = this.layoutCache.get(key);
      if (cached) return cached;
      // Cycle breaker: a type reachable from its own field returns an empty back-edge layout.
      if (this.inProgress.has(key)) return { size: 0, align: 1, fields: new Map() };
      this.inProgress.add(key);
    }

    try {
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
            const al = this.alignOfTypeB(v.type, b);
            fields.set(v.name, { name: v.name, offset: 0, size: sz, type: v.type });
            if (sz > max) max = sz;
            if (al > maxAlign) maxAlign = al;
          }
        }
        const layout = { size: max, align: maxAlign, fields };
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
      const layout = { size, align: maxAlign, fields };
      if (key) this.layoutCache.set(key, layout);
      return layout;
    } finally {
      if (key) this.inProgress.delete(key);
    }
  }

  private alignOfTypeB(t: TypeSpec, b: Bindings): number {
    if (t.kind === "const") return this.alignOfTypeB(t.valueType, b);
    if (t.kind === "reference" || t.kind === "pointer") return 4;
    if (t.kind === "array") return this.alignOfTypeB(t.elem, b);
    // For aggregates, reuse the (cached) layout's computed alignment — avoids a second, uncached
    // recursive walk that blows up on deeply nested templates.
    if (t.kind === "inline_struct") return this.layoutOfStruct(t.struct, b).align;
    if (t.kind === "name") {
      const bound = b.types.get(t.name);
      if (bound) return this.alignOfTypeB(bound, b);
      const s = SCALAR_SIZE[t.name];
      if (s !== undefined) return Math.min(s, 8);
      const td = this.typedefs.get(t.name);
      if (td) return this.alignOfTypeB(td, b);
      const struct = b.structs.get(t.name) ?? this.nested.get(t.name) ?? this.globalStructs.get(t.name);
      if (struct) return this.layoutOfStruct(struct, b).align;
      return 4;
    }
    if (t.kind === "template_instance") {
      if (this.templates.get(t.name)) return this.layoutOfTemplate(t.name, t.args, b).align;
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
    if (t.kind === "expr_value") return `#${this.evalConst(t.expr)}`;
    return "?";
  }

  private alignDepth = 0;

  private structAlign(members: Declaration[], b: Bindings): number {
    if (this.alignDepth > 80) return 8;
    this.alignDepth++;
    try {
      let a = 1;
      for (const m of members) {
        if (m.kind === "variable" && !(m as VariableDecl).isStatic && !(m as VariableDecl).isConstexpr) {
          a = Math.max(a, this.alignOfTypeB((m as VariableDecl).type, b));
        }
      }
      return Math.min(a, 8);
    } finally {
      this.alignDepth--;
    }
  }

  // Evaluate a constant expression, resolving template non-type params (e.g. L) through `b.values`.
  evalConst(expr: Expression, b: Bindings = NO_BIND): number {
    return Number(this.evalConstBig(expr, b));
  }

  // Parse an integer literal token (hex/bin/octal/dec, with optional u/l/ull suffixes) to a bigint.
  private parseIntLiteral(value: string): bigint {
    const text = value.replace(/ull?$/i, "").replace(/llu?$/i, "").replace(/[ul]$/i, "");
    try {
      if (text.startsWith("0x") || text.startsWith("0X")) return BigInt(text);
      if (text.startsWith("0b") || text.startsWith("0B")) return BigInt("0x" + BigInt(text.slice(2)).toString(16));
      if (text.startsWith("0") && text.length > 1) return BigInt("0x" + BigInt(text).toString(16));
      return BigInt(text);
    } catch {
      return 0n;
    }
  }

  private evalConstBig(expr: Expression, b: Bindings): bigint {
    switch (expr.kind) {
      case "int_literal":
        return this.parseIntLiteral(expr.value);
      case "bool_literal": return expr.value ? 1n : 0n;
      case "char_literal": return BigInt(expr.value);
      case "paren": return this.evalConstBig(expr.expr, b);
      case "identifier": {
        const v = b.values.get(expr.name);
        if (v !== undefined) return v;
        const c = this.resolveConst(expr.name);
        if (c !== null) return c;
        if (this.sema && typeof this.sema.evaluateConstexpr === "function") {
          const e = this.sema.evaluateConstexpr(expr);
          if (e !== null) return e;
        }
        return 0n;
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
      } else if (m.kind === "variable") {
        this.collectConstant(m as VariableDecl);
      } else if (m.kind === "enum") {
        this.collectEnum(m as any);
      } else if (m.kind === "typedef_decl") {
        // contract-member typedef (typedef Order _Order;) — register the alias so _Order-typed locals
        // resolve their layout/fields.
        const td = m as any;
        if (!this.typedefs.has(td.name)) this.typedefs.set(td.name, td.type);
      }
    }
  }

  // ---- type → layout / field resolution (used by body codegen for address computation) ----

  alignOfType(t: TypeSpec, b: Bindings = NO_BIND): number {
    return this.alignOfTypeB(t, b);
  }

  // Strip const/reference wrappers to the underlying type (a by-ref aggregate param holds an address
  // to this type, and its fields are laid out by this type).
  derefType(t: TypeSpec): TypeSpec {
    if (t.kind === "const") return this.derefType(t.valueType);
    if (t.kind === "reference") return this.derefType(t.refereed);
    return t;
  }

  // True if a type is an aggregate (id/m256i/struct/array/container) — passed/returned by address
  // rather than as an i64 value. References and const are unwrapped first.
  isAggregateType(t: TypeSpec): boolean {
    if (t.kind === "const") return this.isAggregateType(t.valueType);
    if (t.kind === "reference") return this.isAggregateType(t.refereed);
    if (t.kind === "array" || t.kind === "inline_struct" || t.kind === "template_instance") return true;
    if (t.kind === "name") {
      if (t.name === "id" || t.name === "m256i") return true;
      if (SCALAR_SIZE[t.name] !== undefined) return false;
      return this.layoutOfType(t) !== null;
    }
    return false;
  }

  // Resolve a struct-ish type to its (cached) field layout, or null for scalars/containers.
  layoutOfType(t: TypeSpec, b: Bindings = NO_BIND): StructLayout | null {
    if (t.kind === "const") return this.layoutOfType(t.valueType, b);
    if (t.kind === "inline_struct") return this.layoutOfStruct(t.struct, b);
    if (t.kind === "name") {
      const bound = b.types.get(t.name);
      if (bound) return this.layoutOfType(bound, b);
      if (SCALAR_SIZE[t.name] !== undefined) return null;
      const td = this.typedefs.get(t.name);
      if (td) return this.layoutOfType(td, b);
      const s = b.structs.get(t.name) ?? this.nested.get(t.name) ?? this.globalStructs.get(t.name);
      if (s) return this.layoutOfStruct(s, b);
    }
    return null;
  }

  // Resolve a type to its StructDecl (for inline member-method lookup), following typedefs/bindings.
  structOf(t: TypeSpec, b: Bindings = NO_BIND): StructDecl | null {
    if (t.kind === "const") return this.structOf(t.valueType, b);
    if (t.kind === "reference") return this.structOf(t.refereed, b);
    if (t.kind === "inline_struct") return t.struct;
    if (t.kind === "name") {
      const bound = b.types.get(t.name);
      if (bound) return this.structOf(bound, b);
      const td = this.typedefs.get(t.name);
      if (td) return this.structOf(td, b);
      return b.structs.get(t.name) ?? this.nested.get(t.name) ?? this.globalStructs.get(t.name) ?? null;
    }
    return null;
  }

  // Look up a field within a struct-ish type, returning its offset/size/type.
  fieldOf(t: TypeSpec, member: string, b: Bindings = NO_BIND): FieldLayout | null {
    const layout = this.layoutOfType(t, b);
    return layout ? layout.fields.get(member) ?? null : null;
  }

  // ---- public helpers for compiling instantiated container methods ----

  typeKeyOf(t: TypeSpec): string {
    return this.typeKey(t);
  }

  // The full layout of a container instantiation (HashMap<id,uint64,1024> → _elements/_occupationFlags/...).
  containerLayout(name: string, args: TypeSpec[], b: Bindings = NO_BIND): StructLayout {
    return this.layoutOfTemplate(name, args, b);
  }

  // template params → concrete args (KeyT→id, L→1024). A defaulted trailing param (HashFunc) is omitted.
  // The container's nested structs (HashMap::Element) are added to the scope so method bodies resolve them.
  bindContainer(name: string, args: TypeSpec[], b: Bindings = NO_BIND): Bindings {
    const tmpl = this.templates.get(name);
    const out: Bindings = { types: new Map(), values: new Map(), structs: new Map() };
    if (!tmpl) return out;
    const resolved = args.map((a) => this.resolveType(a, b));
    for (let i = 0; i < tmpl.params.length; i++) {
      const p = tmpl.params[i];
      const arg = resolved[i];
      if (!arg) continue;
      if (p.kind === "type") out.types.set(p.name, arg);
      else out.values.set(p.name, this.evalConstFromType(arg, b));
    }
    for (const m of tmpl.members) {
      if (m.kind === "struct" && (m as StructDecl).name) out.structs.set((m as StructDecl).name, m as StructDecl);
    }
    return out;
  }

  // Evaluate the container's static constexpr members (e.g. _nEncodedFlags = L>32?32:L) under bindings.
  staticConstsOf(name: string, b: Bindings): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const tmpl = this.templates.get(name);
    if (!tmpl) return out;
    for (const m of tmpl.members) {
      if (m.kind === "variable") {
        const v = m as VariableDecl;
        if ((v.isStatic || v.isConstexpr) && v.init) out.set(v.name, this.evalConstBig(v.init, b));
      }
    }
    return out;
  }

  evalConstNum(expr: Expression, b: Bindings): number {
    return Number(this.evalConstBig(expr, b));
  }

  // The hash-container's internal byte offsets, read from the PARSED qpi.h template layout (so they
  // track the real field order / occupation-flag sizing rather than a baked-in formula). Returns null
  // if the template body wasn't captured, in which case callers fall back to the structural formula.
  private hashContainerOffsets(name: string, args: TypeSpec[], b: Bindings, L: number): { elemSize: number; occBase: number; popOff: number; totalSize: number } | null {
    if (!this.templates.has(name) || !L) return null;
    const lt = this.layoutOfTemplate(name, args, b);
    const el = lt.fields.get("_elements") ?? lt.fields.get("_keys");   // HashMap: _elements; HashSet: _keys
    const occ = lt.fields.get("_occupationFlags");
    const pop = lt.fields.get("_population");
    if (!el || !occ || !pop) return null;
    return { elemSize: Math.floor(el.size / L), occBase: occ.offset, popOff: pop.offset, totalSize: lt.size };
  }

  // Concrete offsets/sizes for HashMap<K,V,L>. Key/value sizing follows standard C struct layout of
  // Element{K key; V value}; the occupation/population offsets come from the parsed qpi.h layout.
  hashmapInfo(args: TypeSpec[], b: Bindings = NO_BIND): ContainerInfo | null {
    if (args.length < 3) return null;
    const keySize = this.sizeOfType(args[0], b);
    const valSize = this.sizeOfType(args[1], b);
    const L = Number(this.evalConstFromType(args[2], b));
    if (!L || keySize <= 0 || valSize <= 0) return null;
    const elemAlign = Math.max(this.alignOfType(args[0], b), this.alignOfType(args[1], b));
    const valOff = this.alignUp(keySize, this.alignOfType(args[1], b));

    const parsed = this.hashContainerOffsets("HashMap", args, b, L);
    const elemSize = parsed?.elemSize ?? this.alignUp(valOff + valSize, elemAlign);
    const occBase = parsed?.occBase ?? elemSize * L;
    const popOff = parsed?.popOff ?? occBase + Math.floor((L * 2 + 63) / 64) * 8;
    const totalSize = parsed?.totalSize ?? popOff + 16;
    const hashMode = keySize === 32 ? 0 : 1;
    return { kind: "HashMap", L, elemSize, keySize, valOff, valSize, occBase, popOff, totalSize, hashMode };
  }

  // HashSet<K,L>: keys-only — same probing/occupancy as HashMap with a zero-width value.
  hashsetInfo(args: TypeSpec[], b: Bindings = NO_BIND): ContainerInfo | null {
    if (args.length < 2) return null;
    const keySize = this.sizeOfType(args[0], b);
    const L = Number(this.evalConstFromType(args[1], b));
    if (!L || keySize <= 0) return null;

    const parsed = this.hashContainerOffsets("HashSet", args, b, L);
    const elemSize = parsed?.elemSize ?? this.alignUp(keySize, this.alignOfType(args[0], b));
    const occBase = parsed?.occBase ?? elemSize * L;
    const popOff = parsed?.popOff ?? occBase + Math.floor((L * 2 + 63) / 64) * 8;
    const totalSize = parsed?.totalSize ?? popOff + 16;
    const hashMode = keySize === 32 ? 0 : 1;
    return { kind: "HashMap", L, elemSize, keySize, valOff: 0, valSize: 0, occBase, popOff, totalSize, hashMode };
  }

  arrayInfo(args: TypeSpec[], b: Bindings = NO_BIND): ContainerInfo | null {
    if (args.length < 2) return null;
    const elemSize = this.sizeOfType(args[0], b);
    const L = Number(this.evalConstFromType(args[1], b));
    if (!L || elemSize <= 0) return null;
    return { kind: "Array", L, elemSize, elemType: args[0] };
  }

  // Backing-store geometry for Collection<T, L>.element(i) = _elements[i & (L-1)].value — all offsets
  // read from the parsed layout (the Element record is _elements' array element type).
  collectionInfo(args: TypeSpec[], b: Bindings = NO_BIND): { L: number; elementsOff: number; stride: number; valueOff: number; elemType: TypeSpec } | null {
    if (args.length < 2) return null;
    const L = Number(this.evalConstFromType(args[1], b));
    if (!L) return null;
    const elementsF = this.containerLayout("Collection", args, b).fields.get("_elements");
    const bind = this.bindContainer("Collection", args, b);
    const elemLayout = this.layoutOfType({ kind: "name", name: "Element" }, bind);
    const valueF = elemLayout?.fields.get("value");
    if (!elementsF || !elemLayout || !valueF) return null;
    return { L, elementsOff: elementsF.offset, stride: elemLayout.size, valueOff: valueF.offset, elemType: args[0] };
  }

  warn(message: string, line: number): void {
    this.warnings.push({ message, line });
  }
}

interface HelperInfo {
  label: string;                                              // WAT function name ($h_<name>)
  params: { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec }[];
  retIsValue: boolean;                                        // returns a scalar i64 (vs void)
}

interface PrivateInfo {
  label: string;                                             // WAT function name ($priv_<name>)
  localsSize: number;                                        // sizeof(<name>_locals)
}

interface CompiledMethod {
  label: string;                                             // WAT function name ($T<n>_<Class>_<method>)
  fnParams: { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec }[];
  retKind: "i64" | "void";
}

interface ContainerInfo {
  kind: "HashMap" | "Array";
  L: number;
  elemSize: number;
  keySize?: number;
  valOff?: number;
  valSize?: number;
  occBase?: number;
  popOff?: number;
  totalSize?: number;
  hashMode?: number;
  elemType?: TypeSpec;
}

// ---- entry point ----

export interface LibTypes {
  templates: Map<string, ClassTemplate>;
  globalStructs: Map<string, StructDecl>;
  typedefs: Map<string, TypeSpec>;
  constexprInit: Map<string, Expression>;
  enumConst: Map<string, bigint>;
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>>;
}

// Parse-once: collect the qpi.h library type table (templates/structs/typedefs/constants/methods).
export function buildLibTypes(decls: Declaration[]): LibTypes {
  const cg = new Codegen({} as Sema);
  cg.collectTU(decls);
  return {
    templates: cg.templates,
    globalStructs: cg.globalStructs,
    typedefs: cg.typedefs,
    constexprInit: cg.constexprInit,
    enumConst: cg.enumConst,
    templateMethods: cg.templateMethods,
  };
}

export function generateWasmModule(
  tu: { declarations: Declaration[] },
  sema: Sema,
  contractName: string,
  slot: number,
  arenaSz: number = 1024 * 1024 * 1024,
  lib?: LibTypes,
  callees?: CalleeIdl[],
): string {
  const cg = new Codegen(sema);
  for (const c of callees ?? []) cg.callees.set(c.name, c);

  // Seed the qpi.h library type table (templates / structs / typedefs) parsed once, then add
  // the user contract's own declarations on top.
  if (lib) {
    for (const [k, v] of lib.templates) cg.templates.set(k, v);
    for (const [k, v] of lib.globalStructs) cg.globalStructs.set(k, v);
    for (const [k, v] of lib.typedefs) cg.typedefs.set(k, v);
    for (const [k, v] of lib.constexprInit) cg.constexprInit.set(k, v);
    for (const [k, v] of lib.enumConst) cg.enumConst.set(k, v);
    if (lib.templateMethods) for (const [k, v] of lib.templateMethods) cg.templateMethods.set(k, new Map(v));
  }
  cg.collectTU(tu.declarations);

  const contract = findContractStruct(tu);
  if (!contract) {
    return emitModule({ stateSize: 0, arenaSize: arenaSz, entries: [], sysprocs: [], userFunctionsWat: ";; no contract struct found" });
  }

  cg.collectNested(contract);

  // state size from StateData
  const stateData = cg["nested"].get("StateData");
  const stateLayout = stateData ? cg.layoutOf(stateData) : { size: 0, align: 1, fields: new Map() };
  const stateSize = stateLayout.size;

  // registrations → entries
  const regs = extractRegistrations(contract);
  const entries: UserEntry[] = [];
  const userFns: string[] = [];

  // Collect helper + private functions BEFORE emitting entries, so entry bodies can call them.
  // A member function is: an entry (registered), a system procedure, the register hook, a PRIVATE_
  // function (first param `qpi`, called via CALL), or a plain value helper (e.g. toReturnCode).
  const entryNames = new Set(regs.map((r) => r.fnName));
  const helperFns: FunctionDecl[] = [];
  const privateFns: FunctionDecl[] = [];
  for (const m of contract.members) {
    if (m.kind !== "function") continue;
    const fn = m as FunctionDecl;
    if (!fn.body) continue;
    if (entryNames.has(fn.name) || SYSPROC_IMPL[fn.name] !== undefined) continue;
    if (fn.name === "__registerUserFunctionsAndProcedures" || fn.name.includes("operator") || fn.name === contract.name) continue;

    if (fn.params[0]?.name === "qpi") {
      const localsStruct = cg["nested"].get(`${fn.name}_locals`);
      cg.privates.set(fn.name, { label: `$priv_${fn.name}`, localsSize: localsStruct ? cg.layoutOf(localsStruct).size : 0 });
      privateFns.push(fn);
    } else if (!cg.helpers.has(fn.name)) {
      // overloaded helpers (min(uint64,...) and min(sint64,...)) share one $h_<name> — first wins, so
      // the function is emitted once (a second emission would redefine the wasm function).
      const params = fn.params.map((p) => {
        const isAddr = cg.isAggregateType(p.type);
        return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: cg.derefType(p.type) };
      });
      const retIsValue = fn.returnType.kind !== "void" && !cg.isAggregateType(fn.returnType);
      cg.helpers.set(fn.name, { label: `$h_${fn.name}`, params, retIsValue });
      helperFns.push(fn);
    }
  }

  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i];
    const fn = findMemberFn(contract, reg.fnName);
    const inStruct = cg["nested"].get(`${reg.fnName}_input`);
    const outStruct = cg["nested"].get(`${reg.fnName}_output`);
    const localsStruct = cg["nested"].get(`${reg.fnName}_locals`);
    const inLayout = inStruct ? cg.layoutOf(inStruct) : { size: 0, align: 1, fields: new Map() };
    const outLayout = outStruct ? cg.layoutOf(outStruct) : { size: 0, align: 1, fields: new Map() };
    const localsLayout = localsStruct ? cg.layoutOf(localsStruct) : { size: 0, align: 1, fields: new Map() };

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

  const empty = { size: 0, align: 1, fields: new Map() };
  const layoutFor = (name: string) => {
    const s = cg["nested"].get(name);
    return s ? cg.layoutOf(s) : empty;
  };

  // system procedures. Lifecycle procedures take no input/output but CAN declare locals (the
  // *_WITH_LOCALS forms, e.g. END_EPOCH where contracts run reward distribution) — give them their
  // <name>_locals frame so locals.* resolves, the same as user functions.
  const sysprocs: SysProcInfo[] = [];
  let sysIdx = 0;
  for (const m of contract.members) {
    if (m.kind === "function") {
      const fn = m as FunctionDecl;
      const spId = SYSPROC_IMPL[fn.name];
      if (spId !== undefined) {
        const label = `$sys_${sysIdx++}`;
        const localsLayout = layoutFor(`${SYSPROC_LOCALS_PREFIX[fn.name] ?? fn.name}_locals`);
        userFns.push(emitFunction(cg, label, fn, stateLayout, empty, empty, localsLayout));
        sysprocs.push({ id: spId, localsSize: localsLayout.size, inSize: 0, outSize: 0, label });
      }
    }
  }

  // PRIVATE_ functions share the entry (ctx,state,in,out,locals) shape — emit them with emitFunction.
  for (const fn of privateFns) {
    const info = cg.privates.get(fn.name)!;
    userFns.push(emitFunction(cg, info.label, fn, stateLayout, layoutFor(`${fn.name}_input`), layoutFor(`${fn.name}_output`), layoutFor(`${fn.name}_locals`)));
  }
  for (const fn of helperFns) {
    userFns.push(emitHelperFunction(cg, cg.helpers.get(fn.name)!, fn, stateLayout));
  }

  // Instantiated container methods compiled from the real qpi.h bodies (accumulated while lowering the
  // function bodies above). Appended last; each is emitted once and shared.
  userFns.push(...cg.emittedMethodOrder);

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
  tmpCount: number;
  loops: { brk: string; cont: string }[];   // innermost loop's break/continue labels are last
  loopCount: number;
  params?: Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>;  // value-helper / method parameters (local overrides the wasm slot name when inlining)
  retIsValue?: boolean;                       // function returns a scalar value (return <expr>)
  thisLayout?: StructLayout;                  // when compiling a container method: layout of *this
  thisType?: TypeSpec;                        // the container template_instance (HashMap<id,uint64,1024>)
  thisBind?: Bindings;                        // template-param bindings (KeyT→id, L→1024, ...) for the body
  staticConsts?: Map<string, bigint>;         // the container's static constexpr members (_nEncodedFlags, ...)
  gotoLabels?: Map<string, string>;           // C++ label name → enclosing wasm block label (forward goto)
  refLocals?: Map<string, TypeSpec>;          // reference/pointer locals: name → referent type (holds an address)
  thisAddr?: string;                           // WAT for *this's address (default "(local.get $this)"); set when inlining a struct method
  inlineMethod?: boolean;                       // emitting a struct method inline into the caller — `return` is suppressed (the value flows via thisAddr)
}

// A scratch i32 local (holds an address). Declared lazily; emitted in the function's local list.
function newTmp(ctx: FnCtx): string {
  const n = `tmp${ctx.tmpCount++}`;
  ctx.localVars.set(n, { wasmType: "i32" });
  return n;
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
  const ctx: FnCtx = { cg, state, in: inL, out: outL, locals: localsL, localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0 };

  // Pre-scan for local variable declarations (must be declared at function top in WAT)
  if (fn?.body) collectLocals(fn.body, ctx);

  const header = `  (func ${label} (param $ctx i32) (param $state i32) (param $in i32) (param $out i32) (param $locals i32)`;

  if (fn?.body) {
    emitStmt(ctx, fn.body);
  }

  // Build local decls AFTER emit so scratch temps created during lowering are included.
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);

  return [header, ...localDecls, ...ctx.lines, "  )"].join("\n");
}

// Emit a value-helper (e.g. toReturnCode) as a wasm function with its own scalar/address parameters
// and an optional i64 result. Helpers are static and pure — they take no ctx/state/in/out/locals.
function emitHelperFunction(cg: Codegen, info: HelperInfo, fn: FunctionDecl, stateLayout: StructLayout): string {
  const empty = { size: 0, align: 1, fields: new Map() };
  const ctx: FnCtx = {
    cg, state: stateLayout, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: info.retIsValue,
  };
  for (const p of info.params) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: p.type });

  if (fn.body) collectLocals(fn.body, ctx);

  const paramDecls = info.params.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = info.retIsValue ? " (result i64)" : "";
  const header = `  (func ${info.label} ${paramDecls}${result}`.replace(/\s+\)/, ")");

  if (fn.body) emitStmt(ctx, fn.body);

  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  // A value helper needs a fallthrough result for control paths that do not hit a return.
  const tail = info.retIsValue ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
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
        // reference/pointer locals hold an address (i32); scalars use the i64 value model.
        const isRef = v.type.kind === "reference" || v.type.kind === "pointer";
        const wasmType: "i32" | "i64" = isRef ? "i32" : "i64";
        if (!ctx.localVars.has(v.name)) ctx.localVars.set(v.name, { wasmType });
      }
      break;
    }
  }
}

// Collect goto-target label names appearing anywhere in a statement subtree.
function collectGotosIn(stmt: Statement, out: Set<string>): void {
  switch (stmt.kind) {
    case "goto": out.add(stmt.label); break;
    case "compound": for (const s of stmt.body) collectGotosIn(s, out); break;
    case "if": collectGotosIn(stmt.then, out); if (stmt.else_) collectGotosIn(stmt.else_, out); break;
    case "for": case "while": case "do_while": case "switch": collectGotosIn(stmt.body, out); break;
  }
}

// Collect label names defined anywhere in a statement subtree.
function collectLabelsIn(stmt: Statement, out: Set<string>): void {
  switch (stmt.kind) {
    case "label": out.add(stmt.name); break;
    case "compound": for (const s of stmt.body) collectLabelsIn(s, out); break;
    case "if": collectLabelsIn(stmt.then, out); if (stmt.else_) collectLabelsIn(stmt.else_, out); break;
    case "for": case "while": case "do_while": case "switch": collectLabelsIn(stmt.body, out); break;
  }
}

// Emit a brace block, lowering forward gotos (relooper-lite). A `goto L` that jumps forward to a label
// L rooted in a later sibling becomes a `br` out of a synthesized block wrapping the siblings between
// the goto and L; control lands right before L's sibling, reproducing the jump via natural fall-through.
// (qpi.h's HashMap::set is the canonical case: `goto reuse_slot` exits both probing loops.)
function emitCompound(ctx: FnCtx, body: Statement[]): void {
  // child index where each goto-targeted label is rooted
  const labelChild = new Map<string, number>();
  for (let i = 0; i < body.length; i++) {
    const labels = new Set<string>();
    collectLabelsIn(body[i], labels);
    for (const l of labels) if (!labelChild.has(l)) labelChild.set(l, i);
  }

  // forward gotos only: a label rooted in a later sibling than the goto. Each gets a block wrapping
  // siblings [gotoChild .. labelChild-1], closed right before the label-bearing sibling.
  const wasmLabel = new Map<string, string>();
  const opensAt = new Map<number, { wl: string; closeAt: number }[]>();
  for (let i = 0; i < body.length; i++) {
    const gotos = new Set<string>();
    collectGotosIn(body[i], gotos);
    for (const g of gotos) {
      const lc = labelChild.get(g);
      if (lc === undefined || lc <= i || wasmLabel.has(g)) continue;
      const wl = `$goto_${g}_${ctx.loopCount++}`;
      wasmLabel.set(g, wl);
      if (!opensAt.has(i)) opensAt.set(i, []);
      opensAt.get(i)!.push({ wl, closeAt: lc });
    }
  }

  if (wasmLabel.size === 0) {
    for (const s of body) emitStmt(ctx, s);
    return;
  }

  if (!ctx.gotoLabels) ctx.gotoLabels = new Map();
  for (const [g, wl] of wasmLabel) ctx.gotoLabels.set(g, wl);

  const closeStack: number[] = [];
  for (let i = 0; i < body.length; i++) {
    while (closeStack.length && closeStack[closeStack.length - 1] === i) {
      ctx.lines.push(`    )`);
      closeStack.pop();
    }
    const opens = opensAt.get(i);
    if (opens) {
      opens.sort((a, b) => b.closeAt - a.closeAt);   // outermost (latest close) opens first → proper nesting
      for (const o of opens) {
        ctx.lines.push(`    (block ${o.wl}`);
        closeStack.push(o.closeAt);
      }
    }
    emitStmt(ctx, body[i]);
  }
  while (closeStack.length) {
    ctx.lines.push(`    )`);
    closeStack.pop();
  }

  for (const g of wasmLabel.keys()) ctx.gotoLabels!.delete(g);
}

function emitStmt(ctx: FnCtx, stmt: Statement): void {
  switch (stmt.kind) {
    case "compound":
      emitCompound(ctx, stmt.body);
      break;

    case "expression": {
      const w = emitExprDrop(ctx, stmt.expr);
      if (w) ctx.lines.push(`    ${w}`);
      break;
    }

    case "declaration": {
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it
        // resolves through that address. The referent type (Element, PoV, ...) drives field offsets.
        if (v.type.kind === "reference" || v.type.kind === "pointer") {
          if (v.init) {
            const node = resolveAddr(ctx, v.init);
            if (node) {
              if (!ctx.refLocals) ctx.refLocals = new Map();
              ctx.refLocals.set(v.name, node.type ?? (v.type.kind === "reference" ? v.type.refereed : v.type.pointee));
              ctx.lines.push(`    (local.set $${v.name} ${node.addr})`);
            } else {
              ctx.cg.warn(`unsupported reference initializer for '${v.name}'`, stmt.span.line);
            }
          }
          break;
        }
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
      const n = ctx.loopCount++;
      const brk = `$brk${n}`, loop = `$loop${n}`, cont = `$cont${n}`;
      ctx.lines.push(`    (block ${brk} (loop ${loop}`);
      if (stmt.cond) {
        ctx.lines.push(`      (br_if ${brk} (i32.eqz (i32.wrap_i64 ${emitValue(ctx, stmt.cond)})))`);
      }
      // continue jumps out of the $cont block to run the update, then loops — matching C semantics.
      ctx.lines.push(`      (block ${cont}`);
      ctx.loops.push({ brk, cont });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      if (stmt.update) {
        const u = emitExprDrop(ctx, stmt.update);
        if (u) ctx.lines.push(`      ${u}`);
      }
      ctx.lines.push(`      (br ${loop})))`);
      break;
    }

    case "while": {
      const n = ctx.loopCount++;
      const brk = `$brk${n}`, loop = `$loop${n}`, cont = `$cont${n}`;
      ctx.lines.push(`    (block ${brk} (loop ${loop}`);
      ctx.lines.push(`      (br_if ${brk} (i32.eqz (i32.wrap_i64 ${emitValue(ctx, stmt.cond)})))`);
      ctx.lines.push(`      (block ${cont}`);
      ctx.loops.push({ brk, cont });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      ctx.lines.push(`      (br ${loop})))`);
      break;
    }

    case "do_while": {
      const n = ctx.loopCount++;
      const brk = `$brk${n}`, loop = `$loop${n}`, cont = `$cont${n}`;
      ctx.lines.push(`    (block ${brk} (loop ${loop}`);
      ctx.lines.push(`      (block ${cont}`);
      ctx.loops.push({ brk, cont });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      ctx.lines.push(`      (br_if ${loop} (i32.ne (i32.const 0) (i32.wrap_i64 ${emitValue(ctx, stmt.cond)})))))`);
      break;
    }

    case "switch": {
      const n = ctx.loopCount++;
      const brk = `$swbrk${n}`, sw = `sw${n}`;
      ctx.localVars.set(sw, { wasmType: "i64" });
      ctx.lines.push(`    (local.set $${sw} ${emitValue(ctx, stmt.cond)})`);
      ctx.lines.push(`    (block ${brk}`);
      // break targets the switch; continue still targets the enclosing loop (if any).
      const cont = ctx.loops.length ? ctx.loops[ctx.loops.length - 1].cont : brk;
      ctx.loops.push({ brk, cont });
      const body = stmt.body.kind === "compound" ? stmt.body.body : [stmt.body];
      // group statements by case/default markers; each non-default case is a guarded block that
      // breaks out at its end (the qpi.h container switches never fall through).
      const groups: { test: string | null; stmts: Statement[] }[] = [];
      for (const s of body) {
        if (s.kind === "case") groups.push({ test: `(i64.eq (local.get $${sw}) ${emitValue(ctx, s.value)})`, stmts: [] });
        else if (s.kind === "default") groups.push({ test: null, stmts: [] });
        else if (groups.length) groups[groups.length - 1].stmts.push(s);
      }
      for (const g of groups) {
        if (g.test) {
          ctx.lines.push(`      (if ${g.test} (then`);
          for (const s of g.stmts) emitStmt(ctx, s);
          ctx.lines.push(`        (br ${brk})))`);
        } else {
          for (const s of g.stmts) emitStmt(ctx, s);
        }
      }
      ctx.loops.pop();
      ctx.lines.push(`    )`);
      break;
    }

    case "break":
      if (ctx.loops.length) ctx.lines.push(`    (br ${ctx.loops[ctx.loops.length - 1].brk})`);
      else ctx.cg.warn(`break outside loop`, stmt.span.line);
      break;

    case "continue":
      if (ctx.loops.length) ctx.lines.push(`    (br ${ctx.loops[ctx.loops.length - 1].cont})`);
      else ctx.cg.warn(`continue outside loop`, stmt.span.line);
      break;

    case "return":
      // an inlined struct method's `return *this` carries no value out (the object flows via thisAddr);
      // emitting a wasm return here would wrongly exit the enclosing function.
      if (ctx.inlineMethod) break;
      if (stmt.value && ctx.retIsValue) ctx.lines.push(`    (return ${emitValue(ctx, stmt.value)})`);
      else ctx.lines.push(`    (return)`);
      break;

    case "static_assert":
    case "empty":
    case "label":
      break;

    case "goto": {
      const wl = ctx.gotoLabels?.get(stmt.label);
      if (wl) ctx.lines.push(`    (br ${wl})`);
      else ctx.cg.warn(`unsupported goto '${stmt.label}'`, stmt.span.line);
      break;
    }

    default:
      ctx.cg.warn(`unsupported statement '${stmt.kind}'`, stmt.span.line);
      break;
  }
}

// Emit an expression used as a statement (side effects only). Calls/assignments push their own
// lines to ctx; only inc/dec returns a WAT string for the caller to push.
function emitExprDrop(ctx: FnCtx, expr: Expression): string {
  if (expr.kind === "assign") return emitAssign(ctx, expr);
  if (expr.kind === "call") {
    emitCall(ctx, expr);
    return "";
  }
  if (expr.kind === "postfix_op" || expr.kind === "prefix_op") return emitIncDec(ctx, expr);
  // comma sequence (for-update `i++, flags >>= 2`): emit each side effect in order.
  if (expr.kind === "sequence") {
    for (const e of expr.exprs) {
      const w = emitExprDrop(ctx, e);
      if (w) ctx.lines.push(`    ${w}`);
    }
    return "";
  }
  return "";
}

// A name held in a wasm local slot: a body-declared local OR a scalar (by-value) parameter. Both are
// read via local.get and written via local.set (wasm parameters are mutable locals).
function isScalarLocal(ctx: FnCtx, name: string): boolean {
  if (ctx.localVars.has(name)) return true;
  const p = ctx.params?.get(name);
  return !!p && !p.isAddr;
}

function emitIncDec(ctx: FnCtx, expr: Expression): string {
  const arg = expr.kind === "postfix_op" || expr.kind === "prefix_op" ? expr.arg : expr;
  const op = (expr as any).op === "++" ? "i64.add" : "i64.sub";
  // A scalar local/value-param increments in place via local.set.
  if (arg.kind === "identifier" && isScalarLocal(ctx, arg.name)) {
    return `(local.set $${arg.name} (${op} (local.get $${arg.name}) (i64.const 1)))`;
  }
  // Otherwise a member/element lvalue: load, adjust, store back.
  const addr = tryLvalueAddr(ctx, arg);
  if (addr) {
    const load = loadAt(addr.addr, addr.size);
    const stored = `(${op} ${load} (i64.const 1))`;
    return storeAt(addr.addr, addr.size, stored);
  }
  return "";
}

// ---- lvalue addressing ----

interface Lvalue {
  addr: string;   // WAT producing the i32 byte address
  size: number;   // field size in bytes
}

// A resolved memory location: its address, the pointee type (null at a struct root), the byte size,
// and the field layout for further member access (null for scalars/containers).
interface AddrNode {
  addr: string;
  type: TypeSpec | null;
  size: number;
  layout: StructLayout | null;
}

// True if `state.get()` / `state.mut()`.
function isStateAccessor(expr: Expression): boolean {
  return expr.kind === "call" && expr.callee.kind === "member_access" &&
    expr.callee.object.kind === "identifier" && expr.callee.object.name === "state" &&
    (expr.callee.member === "mut" || expr.callee.member === "get");
}

// id/m256i expose their 32 bytes as fixed-width limb views (`.u64`/`.u32`/`.u16`/`.u8`) with named limbs
// `_0.._N` at element-sized strides. Each view is a synthetic struct layout.
function limbLayout(elemSize: number, count: number): StructLayout {
  const t: TypeSpec = { kind: "name", name: elemSize === 8 ? "uint64" : elemSize === 4 ? "uint32" : elemSize === 2 ? "uint16" : "uint8" };
  const fields = new Map<string, FieldLayout>();
  for (let i = 0; i < count; i++) fields.set(`_${i}`, { name: `_${i}`, offset: i * elemSize, size: elemSize, type: t });
  return { size: elemSize * count, align: elemSize, fields };
}
const ID_VIEWS: Record<string, StructLayout> = {
  u64: limbLayout(8, 4), u32: limbLayout(4, 8), u16: limbLayout(2, 16), u8: limbLayout(1, 32),
};
function isIdLike(cg: Codegen, t: TypeSpec | null): boolean {
  if (!t) return false;
  const d = cg.derefType(t);
  return d.kind === "name" && (d.name === "id" || d.name === "m256i");
}
function isUint128(cg: Codegen, t: TypeSpec | null): boolean {
  if (!t) return false;
  const d = cg.derefType(t);
  return d.kind === "name" && (d.name === "uint128" || d.name === "uint128_t");
}

// Resolve the address of an lvalue expression (member-access chains rooted at input/output/locals/state).
function resolveAddr(ctx: FnCtx, expr: Expression): AddrNode | null {
  // roots
  if (expr.kind === "identifier") {
    if (expr.name === "input") return { addr: "(local.get $in)", type: null, size: ctx.in.size, layout: ctx.in };
    if (expr.name === "output") return { addr: "(local.get $out)", type: null, size: ctx.out.size, layout: ctx.out };
    if (expr.name === "locals") return { addr: "(local.get $locals)", type: null, size: ctx.locals.size, layout: ctx.locals };
    // a reference/pointer local holds the address of its referent; chain member access through it.
    if (ctx.refLocals?.has(expr.name)) {
      const t = ctx.refLocals.get(expr.name)!;
      return { addr: `(local.get $${expr.name})`, type: t, size: ctx.cg.sizeOfType(t, ctx.thisBind ?? NO_BIND), layout: ctx.cg.layoutOfType(t, ctx.thisBind ?? NO_BIND) };
    }
    // an aggregate value-helper / container-method parameter holds the address of its argument; its
    // type may reference template params (KeyT, ValueT), so resolve sizes through the binding.
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) {
      const b = ctx.thisBind ?? NO_BIND;
      return { addr: `(local.get $${p.local ?? expr.name})`, type: p.type, size: ctx.cg.sizeOfType(p.type, b), layout: ctx.cg.layoutOfType(p.type, b) };
    }
    // inside a compiled container method (or an inlined struct method): `this`, or a bare member of *this
    if (ctx.thisLayout) {
      const thisAddr = ctx.thisAddr ?? "(local.get $this)";
      if (expr.name === "this") return { addr: thisAddr, type: ctx.thisType ?? null, size: ctx.thisLayout.size, layout: ctx.thisLayout };
      const f = ctx.thisLayout.fields.get(expr.name);
      if (f) return { addr: addrOf(thisAddr, f.offset), type: f.type, size: f.size, layout: ctx.cg.layoutOfType(f.type, ctx.thisBind) };
    }
    return null;
  }

  // arr[i] / ptr[i]: element address from an array member (this+off) or a pointer-valued operand.
  if (expr.kind === "subscript") {
    const base = resolveAddr(ctx, expr.object);
    let baseAddr: string | null = null, elemType: TypeSpec | null = null;
    if (base?.type?.kind === "array") { baseAddr = base.addr; elemType = base.type.elem; }
    else if (base?.type?.kind === "pointer") { baseAddr = base.addr; elemType = base.type.pointee; }
    if (!baseAddr || !elemType) return null;
    const elemSize = ctx.cg.sizeOfType(elemType, ctx.thisBind);
    const idx = `(i32.mul (i32.wrap_i64 ${emitValue(ctx, expr.index)}) (i32.const ${elemSize}))`;
    return { addr: `(i32.add ${baseAddr} ${idx})`, type: elemType, size: elemSize, layout: ctx.cg.layoutOfType(elemType, ctx.thisBind) };
  }

  if (expr.kind === "paren") return resolveAddr(ctx, expr.expr);

  // inside a compiled container method: `this` (the object) and `*this` both address the instance.
  if (expr.kind === "this" && ctx.thisLayout) {
    return { addr: ctx.thisAddr ?? "(local.get $this)", type: ctx.thisType ?? null, size: ctx.thisLayout.size, layout: ctx.thisLayout };
  }
  // &lvalue (address-of) and *this (deref) are identity at the addressing level — the node already
  // carries the operand's address.
  if (expr.kind === "unary_op" && expr.op === "&") return resolveAddr(ctx, expr.arg);
  if (expr.kind === "unary_op" && expr.op === "*") {
    if (expr.arg.kind === "this") return resolveAddr(ctx, expr.arg);
    // *ptr: a pointer param/local holds the pointed-to address, so dereferencing yields that address.
    const pn = resolveAddr(ctx, expr.arg);
    const pt = pn?.type ? ctx.cg.derefType(pn.type) : null;
    if (pn && pt?.kind === "pointer") {
      const pointee = pt.pointee;
      const sz = ctx.cg.sizeOfType(pointee, ctx.thisBind ?? NO_BIND) || 8;
      return { addr: pn.addr, type: pointee, size: sz, layout: ctx.cg.layoutOfType(pointee, ctx.thisBind ?? NO_BIND) };
    }
    return null;
  }

  if (isStateAccessor(expr)) {
    return { addr: "(local.get $state)", type: null, size: ctx.state.size, layout: ctx.state };
  }

  // a container element getter (arr.get(i), map.value(i)/key(i)) is an lvalue we can keep chaining from
  if (expr.kind === "call") {
    const ce = resolveContainerElem(ctx, expr);
    if (ce) return ce;
    // obj.method(args) where method is an inline member of obj's struct returning a reference (the fluent
    // `Element& init(...) { ...; return *this; }` pattern) — emit it inline, resolve to the object address.
    return tryInlineStructMethod(ctx, expr);
  }

  // member access: resolve the object, then index its field
  if (expr.kind === "member_access") {
    const parent = resolveAddr(ctx, expr.object);
    if (!parent) return null;
    // id/m256i limb views (`.u64`/`.u32`/`.u16`/`.u8`) → a fixed-width array at the value's base.
    if (isIdLike(ctx.cg, parent.type) && ID_VIEWS[expr.member]) {
      return { addr: parent.addr, type: null, size: 32, layout: ID_VIEWS[expr.member] };
    }
    // uint128 `.low` / `.high` → the low / high 64-bit half (low at offset 0).
    if (isUint128(ctx.cg, parent.type) && (expr.member === "low" || expr.member === "high")) {
      return { addr: addrOf(parent.addr, expr.member === "low" ? 0 : 8), type: { kind: "name", name: "uint64" }, size: 8, layout: null };
    }
    if (!parent.layout) return null;
    const f = parent.layout.fields.get(expr.member);
    if (!f) return null;
    return {
      addr: addrOf(parent.addr, f.offset),
      type: f.type,
      size: f.size,
      layout: ctx.cg.layoutOfType(f.type),
    };
  }

  return null;
}

// Scalar lvalue (size <= 8) address+size, for load/store of a scalar field.
function tryLvalueAddr(ctx: FnCtx, expr: Expression): Lvalue | null {
  const n = resolveAddr(ctx, expr);
  if (!n) return null;
  return { addr: n.addr, size: n.size };
}

// Address of an lvalue or a materializable aggregate. Returns null if not addressable.
// SELF expands (in the preprocessor) to id(CONTRACT_INDEX,0,0,0), so id/m256i constructors and
// id::zero() are materialized here into a 32-byte scratch slot.
function emitAddr(ctx: FnCtx, expr: Expression): string | null {
  if (expr.kind === "identifier" && expr.name === "SELF") return "(call $self_id)";
  // an aggregate value-helper parameter is passed by address
  if (expr.kind === "identifier") {
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) return `(local.get $${p.local ?? expr.name})`;
  }
  if (expr.kind === "paren") return emitAddr(ctx, expr.expr);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") return emitAddr(ctx, expr.expr);

  // aggregate construction Type{...} as an rvalue/argument — materialize into a scratch slot.
  if (expr.kind === "construct") {
    const sz = ctx.cg.sizeOfType(expr.type, ctx.thisBind ?? NO_BIND);
    if (sz > 0) {
      const t = newTmp(ctx);
      ctx.lines.push(`    (local.set $${t} (call $qpiAllocLocals (i32.const ${sz})))`);
      if (emitConstruct(ctx, `(local.get $${t})`, expr.type, expr.args)) return `(local.get $${t})`;
    }
  }

  // id(a,b,c,d) / m256i(a,b,c,d) constructor → materialize the four 64-bit limbs (missing ones = 0).
  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "id" || expr.callee.name === "m256i")) {
    return materializeId(ctx, expr.args);
  }
  // id::zero() / m256i::zero() → 32 zero bytes (X::y parses as one qualified identifier "X::y")
  if (expr.kind === "call" && expr.callee.kind === "identifier" &&
    (expr.callee.name === "id::zero" || expr.callee.name === "m256i::zero")) {
    return materializeId(ctx, []);
  }

  // qpi.invocator() / qpi.originator() return an id by value → materialize via the ctx forwarder.
  if (expr.kind === "call" && expr.callee.kind === "member_access" &&
    expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const fwd = QPI_ID_PRODUCERS[expr.callee.member];
    if (fwd) {
      const t = newTmp(ctx);
      ctx.lines.push(`    (local.set $${t} (call $qpiAllocLocals (i32.const 32)))`);
      ctx.lines.push(`    (call ${fwd} (local.get $${t}))`);
      return `(local.get $${t})`;
    }
  }

  const n = resolveAddr(ctx, expr);
  return n ? n.addr : null;
}

// A call `obj.method(args)` where method is an inline member of obj's struct that returns a reference
// (the fluent `Element& init(...) { this->x = ...; return *this; }` pattern). Emit the method body inline
// with `this` bound to the object's address, then resolve to that address (the returned *this).
function tryInlineStructMethod(ctx: FnCtx, expr: Expression & { kind: "call" }): AddrNode | null {
  if (expr.callee.kind !== "member_access") return null;
  const method = expr.callee.member;
  const objNode = resolveAddr(ctx, expr.callee.object);
  if (!objNode || !objNode.layout || !objNode.type) return null;
  const struct = ctx.cg.structOf(objNode.type, ctx.thisBind ?? NO_BIND);
  if (!struct) return null;
  const fn = struct.members.find(
    (m) => m.kind === "function" && (m as FunctionDecl).name === method && (m as FunctionDecl).body,
  ) as FunctionDecl | undefined;
  if (!fn) return null;
  const addr = emitInlineStructMethod(ctx, objNode, fn, expr.args);
  return { addr, type: objNode.type, size: objNode.size, layout: objNode.layout };
}

// Emit a struct member method inline into the current function: stash the object address in a temp (used
// as `this` and returned), materialize each argument into its own slot, then lower the body with `this`
// rebound and `return` suppressed. The this-context is swapped on the shared ctx and restored after.
function emitInlineStructMethod(ctx: FnCtx, objNode: AddrNode, fn: FunctionDecl, args: Expression[]): string {
  const self = newTmp(ctx);
  ctx.lines.push(`    (local.set $${self} ${objNode.addr})`);
  const bind = ctx.thisBind ?? NO_BIND;

  const params = new Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>();
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    const cls = classifyMethodParam(ctx.cg, p, bind);
    const slot = `marg${ctx.tmpCount++}`;
    ctx.localVars.set(slot, { wasmType: cls.wasmType });
    const arg = args[i];
    if (arg) {
      const v = cls.isAddr ? argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(p.type), bind)) : emitValue(ctx, arg);
      ctx.lines.push(`    (local.set $${slot} ${v})`);
    }
    params.set(p.name, { wasmType: cls.wasmType, isAddr: cls.isAddr, type: ctx.cg.derefType(p.type), local: slot });
  }

  const save = {
    thisLayout: ctx.thisLayout, thisType: ctx.thisType, thisAddr: ctx.thisAddr,
    params: ctx.params, inlineMethod: ctx.inlineMethod, retIsValue: ctx.retIsValue,
  };
  ctx.thisLayout = objNode.layout ?? undefined;
  ctx.thisType = objNode.type ?? undefined;
  ctx.thisAddr = `(local.get $${self})`;
  ctx.params = params;
  ctx.inlineMethod = true;
  ctx.retIsValue = false;
  if (fn.body) emitStmt(ctx, fn.body);
  Object.assign(ctx, save);

  return `(local.get $${self})`;
}

// Resolve a container element getter to an addressable node: Array.get(i) → T, HashMap value(i) → V /
// key(i) → K, HashSet key(i) → K. The element address is an lvalue into the backing store, and the
// element TYPE lets resolveAddr keep chaining (e.g. arr.get(i).field). Element type + offsets are
// derived from the template args, never hardcoded.
function resolveContainerElem(ctx: FnCtx, expr: Expression & { kind: "call" }): AddrNode | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  if (!node || node.type?.kind !== "template_instance" || !expr.args[0]) return null;
  const m = expr.callee.member;
  const C = (n: number) => `(i32.const ${n})`;
  const mk = (addr: string, elemType: TypeSpec): AddrNode => ({
    addr, type: elemType, size: ctx.cg.sizeOfType(elemType), layout: ctx.cg.layoutOfType(elemType),
  });

  if (node.type.name === "Array" && m === "get") {
    const info = ctx.cg.arrayInfo(node.type.args);
    if (!info) return null;
    const addr = `(i32.add ${node.addr} (i32.mul (i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)}) ${C(info.elemSize)}))`;
    return mk(addr, node.type.args[0]);
  }
  if (node.type.name === "HashMap" || node.type.name === "HashSet") {
    const info = node.type.name === "HashSet" ? ctx.cg.hashsetInfo(node.type.args) : ctx.cg.hashmapInfo(node.type.args);
    if (!info) return null;
    const elem = `(call $hm_elem ${node.addr} (i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)}) ${C(info.elemSize)})`;
    if (m === "key") return mk(elem, node.type.args[0]);
    if (m === "value" && node.type.name === "HashMap") return mk(`(i32.add ${elem} ${C(info.valOff!)})`, node.type.args[1]);
  }
  // Collection.element(i) → &_elements[i & (L-1)].value: an lvalue of element type T, so element(i).field
  // chains. (A scalar T also flows as a value through emitContainerCall's compiled getter.)
  if (node.type.name === "Collection" && m === "element") {
    const info = ctx.cg.collectionInfo(node.type.args);
    if (!info) return null;
    const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)})`;
    const addr = `(i32.add ${node.addr} (i32.add ${C(info.elementsOff + info.valueOff)} (i32.mul ${idx} ${C(info.stride)})))`;
    return mk(addr, info.elemType);
  }
  return null;
}

// qpi.* zero-arg accessors that return a 32-byte id by value, written to an out address.
const QPI_ID_PRODUCERS: Record<string, string> = {
  invocator: "$qpi_invocator",
  originator: "$qpi_originator",
};

// Aggregate construction `Type{ a, b, c }` written into dstAddr: zero the target, then store each arg into
// the corresponding field (declaration order). Scalars store by value, aggregate fields copy by address.
// Returns false if the type has no resolvable layout.
function emitConstruct(ctx: FnCtx, dstAddr: string, type: TypeSpec, args: Expression[]): boolean {
  const layout = ctx.cg.layoutOfType(type, ctx.thisBind ?? NO_BIND);
  if (!layout) return false;
  const fields = [...layout.fields.values()];
  const t = newTmp(ctx);
  ctx.lines.push(`    (local.set $${t} ${dstAddr})`);
  ctx.lines.push(`    (call $setMem (local.get $${t}) (i32.const ${layout.size}) (i32.const 0))`);
  for (let i = 0; i < args.length && i < fields.length; i++) {
    const f = fields[i];
    const fAddr = addrOf(`(local.get $${t})`, f.offset);
    if (isAggregate(ctx, f.type, f.size)) {
      const src = emitAddr(ctx, args[i]);
      if (src) ctx.lines.push(`    (call $copyMem ${fAddr} ${src} (i32.const ${f.size}))`);
    } else {
      ctx.lines.push(`    ${storeAt(fAddr, f.size, emitValue(ctx, args[i]))}`);
    }
  }
  return true;
}

// Materialize a 256-bit id/m256i from up to four 64-bit limb expressions into scratch; returns its addr.
function materializeId(ctx: FnCtx, limbs: Expression[]): string {
  const t = newTmp(ctx);
  ctx.lines.push(`    (local.set $${t} (call $qpiAllocLocals (i32.const 32)))`);
  for (let i = 0; i < 4; i++) {
    const v = limbs[i] ? emitValue(ctx, limbs[i]) : "(i64.const 0)";
    ctx.lines.push(`    (i64.store ${addrOf(`(local.get $${t})`, i * 8)} ${v})`);
  }
  return `(local.get $${t})`;
}

// True if a type is an aggregate (id/m256i/struct/array) that lives in memory rather than an i64.
function isAggregate(ctx: FnCtx, type: TypeSpec | null, size: number): boolean {
  if (!type) return size > 8;
  if (type.kind === "name" && (type.name === "id" || type.name === "m256i")) return true;
  if (type.kind === "array" || type.kind === "inline_struct" || type.kind === "template_instance") return true;
  if (type.kind === "name" && ctx.cg.layoutOfType(type)) return true;
  return size > 8;
}

// Address of an argument: an lvalue/SELF directly, else materialize the scalar value into scratch.
function argAddr(ctx: FnCtx, expr: Expression, size: number): string {
  const a = emitAddr(ctx, expr);
  if (a) return a;
  const t = newTmp(ctx);
  ctx.lines.push(`    (local.set $${t} (call $qpiAllocLocals (i32.const ${size})))`);
  ctx.lines.push(`    ${storeAt(`(local.get $${t})`, size, emitValue(ctx, expr))}`);
  return `(local.get $${t})`;
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

// Lowers an assignment by pushing WAT lines to ctx; returns "" (the statement is fully emitted).
function emitAssign(ctx: FnCtx, expr: Expression & { kind: "assign" }): string {
  const lhs = resolveAddr(ctx, expr.left);

  // aggregate target (id/m256i/struct/array): copy by value, or let a qpi producer write into it
  if (lhs && expr.op === "=" && isAggregate(ctx, lhs.type, lhs.size)) {
    if (expr.right.kind === "call") {
      const out = emitQpiCall(ctx, expr.right, lhs.addr);
      if (out && out.ret === "out") {
        ctx.lines.push(`    ${out.wat}`);
        return "";
      }
    }
    // aggregate construction `target = Type{ ... }` (e.g. a Logger) — materialize the fields in place.
    if (expr.right.kind === "construct" && lhs.type && emitConstruct(ctx, lhs.addr, lhs.type, expr.right.args)) {
      return "";
    }
    const src = emitAddr(ctx, expr.right);
    if (src) {
      ctx.lines.push(`    (call $copyMem ${lhs.addr} ${src} (i32.const ${lhs.size}))`);
      return "";
    }
    ctx.cg.warn(`unsupported aggregate assignment`, expr.span.line);
    return "";
  }

  // scalar field target
  if (lhs) {
    const rhs = emitValue(ctx, expr.right);
    if (expr.op === "=") {
      ctx.lines.push(`    ${storeAt(lhs.addr, lhs.size, rhs)}`);
      return "";
    }
    const op = compoundOp(expr.op);
    ctx.lines.push(`    ${storeAt(lhs.addr, lhs.size, `(${op} ${loadAt(lhs.addr, lhs.size)} ${rhs})`)}`);
    return "";
  }

  // local variable / scalar value-parameter target (both are mutable wasm locals)
  if (expr.left.kind === "identifier" && isScalarLocal(ctx, expr.left.name)) {
    const n = expr.left.name;
    const rhs = emitValue(ctx, expr.right);
    if (expr.op === "=") ctx.lines.push(`    (local.set $${n} ${rhs})`);
    else ctx.lines.push(`    (local.set $${n} (${compoundOp(expr.op)} (local.get $${n}) ${rhs}))`);
    return "";
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
      // a reference local is an address, not a scalar value — its scalar use is always via a member
      // (handled by resolveAddr below); a bare aggregate read is unsupported.
      if (ctx.localVars.has(expr.name) && !ctx.refLocals?.has(expr.name)) return `(local.get $${expr.name})`;
      const p = ctx.params?.get(expr.name);
      if (p && !p.isAddr) return `(local.get $${p.local ?? expr.name})`;
      if (expr.name === "SELF_INDEX") return `(i64.extend_i32_u (call $qpi_contractIndex))`;
      if (expr.name === "NULL") return `(i64.const 0)`;
      // inside a compiled container method: a template non-type param (L), a static constexpr member
      // (_nEncodedFlags), or a bare scalar member of *this (_population).
      if (ctx.thisBind?.values.has(expr.name)) return `(i64.const ${ctx.thisBind.values.get(expr.name)})`;
      if (ctx.staticConsts?.has(expr.name)) return `(i64.const ${ctx.staticConsts.get(expr.name)})`;
      if (ctx.thisLayout) {
        const tn = resolveAddr(ctx, expr);
        if (tn && tn.size <= 8) return loadAt(tn.addr, tn.size);
      }
      // a named constant: enum constant or constexpr (incl. qualified Type::NAME)
      const c = ctx.cg.resolveConst(expr.name);
      if (c !== null) return `(i64.const ${c})`;
      const e = ctx.cg["sema"].evaluateConstexpr(expr);
      if (e !== null) return `(i64.const ${e})`;
      ctx.cg.warn(`unknown identifier '${expr.name}'`, expr.span.line);
      return `(i64.const 0)`;
    }
    case "member_access": {
      const n = resolveAddr(ctx, expr);
      if (n && n.size <= 8) return loadAt(n.addr, n.size);
      if (n) {
        ctx.cg.warn(`aggregate value read unsupported`, expr.span.line);
        return `(i64.const 0)`;
      }
      // qpi.invocationReward() etc. handled in call; bare member returns 0
      ctx.cg.warn(`unsupported member read`, expr.span.line);
      return `(i64.const 0)`;
    }
    case "subscript": {
      const n = resolveAddr(ctx, expr);
      if (n && n.size <= 8) return loadAt(n.addr, n.size);
      ctx.cg.warn(`unsupported subscript value`, (expr as any).span?.line ?? 0);
      return `(i64.const 0)`;
    }
    case "call":
      return emitCallValue(ctx, expr);
    case "template_call": {
      if (expr.callee.kind === "identifier") {
        const name = expr.callee.name;
        // C++ cast spelled as a template call: identity in the scalar i64 model.
        if ((name === "static_cast" || name === "reinterpret_cast" || name === "const_cast") && expr.args[0]) {
          return emitValue(ctx, expr.args[0]);
        }
        const m = emitMathCall(ctx, name, expr.args);
        if (m !== null) return m;
      }
      ctx.cg.warn(`unsupported template_call '${expr.callee.kind === "identifier" ? expr.callee.name : "?"}' as value`, expr.span.line);
      return `(i64.const 0)`;
    }
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
    case "prefix_op": {
      // ++x / --x as a value: apply in place (as a side-effect line), then yield the new value.
      const w = emitIncDec(ctx, expr);
      if (w) ctx.lines.push(`    ${w}`);
      return emitValue(ctx, expr.arg);
    }
    case "postfix_op": {
      // x++ / x-- as a value: capture the old value, then apply — the expression evaluates to the old.
      const t = `tmp${ctx.tmpCount++}`;
      ctx.localVars.set(t, { wasmType: "i64" });
      ctx.lines.push(`    (local.set $${t} ${emitValue(ctx, expr.arg)})`);
      const w = emitIncDec(ctx, expr);
      if (w) ctx.lines.push(`    ${w}`);
      return `(local.get $${t})`;
    }
    case "ternary":
      return `(select ${emitValue(ctx, expr.then)} ${emitValue(ctx, expr.else_)} (i32.wrap_i64 ${emitValue(ctx, expr.cond)}))`;
    case "c_cast":
    case "static_cast":
      return emitValue(ctx, expr.expr);
    case "sizeof_type":
      return `(i64.const ${ctx.cg.sizeOfType(expr.type, ctx.thisBind ?? NO_BIND)})`;
    case "sizeof_expr": {
      // sizeof someLvalue — e.g. sizeof(*this) (the container).
      const n = resolveAddr(ctx, expr.expr);
      if (n) return `(i64.const ${n.size})`;
      // sizeof(TypeName) parses here when the operand is a bare type (e.g. sizeof(Element)) rather than
      // a value — size it as a type, resolving template params (Element) through the binding.
      if (expr.expr.kind === "identifier") {
        const sz = ctx.cg.sizeOfType({ kind: "name", name: expr.expr.name }, ctx.thisBind ?? NO_BIND);
        if (sz > 0) return `(i64.const ${sz})`;
      }
      ctx.cg.warn(`unsupported sizeof expr`, expr.span.line);
      return `(i64.const 0)`;
    }
    default:
      ctx.cg.warn(`unsupported expression '${expr.kind}' as value`, (expr as any).span?.line ?? 0);
      return `(i64.const 0)`;
  }
}

// Address+size of an operand that is an aggregate (id/m256i/struct): a struct-field lvalue, or a
// materialized id producer (SELF / id(...) / qpi.invocator()). Null for scalars.
function aggOperand(ctx: FnCtx, expr: Expression): { addr: string; size: number } | null {
  const n = resolveAddr(ctx, expr);
  if (n) return n.size > 8 ? { addr: n.addr, size: n.size } : null;
  const a = emitAddr(ctx, expr);
  return a ? { addr: a, size: 32 } : null;
}

function emitBinary(ctx: FnCtx, expr: Expression & { kind: "binary_op" }): string {
  // id/struct equality compares bytes, not an i64 value.
  if (expr.op === "==" || expr.op === "!=") {
    const la = aggOperand(ctx, expr.left);
    const ra = aggOperand(ctx, expr.right);
    if (la && ra) {
      const eq = `(call $memeq ${la.addr} ${ra.addr} (i32.const ${Math.min(la.size, ra.size)}))`;
      return expr.op === "==" ? `(i64.extend_i32_u ${eq})` : `(i64.extend_i32_u (i32.eqz ${eq}))`;
    }
  }

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

// qpi.* zero-arg getters → forwarder + scalar return width.
const QPI_GETTERS: Record<string, { fwd: string; ret: "i64" | "i32" }> = {
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

// qpi.* host calls taking args / returning values. Arg kinds map to forwarder param types:
//   i64 = scalar value, i32 = scalar truncated, addr = address of an id/struct lvalue (or SELF),
//   cidx = the contract's own index (SELF_INDEX, injected, not taken from the call's args).
// ret "out" = void forwarder whose LAST param is an output address the produced id/struct is written
// into — used as an assignment RHS (e.g. output.next = qpi.nextId(input.cur)).
type ArgKind = "i64" | "i32" | "addr" | "cidx";
interface QpiCallDesc {
  fwd: string;
  args: ArgKind[];
  ret: "i64" | "i32" | "void" | "out";
}

const QPI_CALLS: Record<string, QpiCallDesc> = {
  transfer: { fwd: "$qpi_transfer", args: ["addr", "i64"], ret: "i64" },
  burn: { fwd: "$qpi_burn", args: ["i64", "cidx"], ret: "i64" },
  issueAsset: { fwd: "$qpi_issueAsset", args: ["i64", "addr", "i32", "i64", "i64"], ret: "i64" },
  isAssetIssued: { fwd: "$qpi_isAssetIssued", args: ["addr", "i64"], ret: "i32" },
  transferShareOwnershipAndPossession: { fwd: "$qpi_transferShares", args: ["i64", "addr", "addr", "addr", "i64", "addr"], ret: "i64" },
  numberOfPossessedShares: { fwd: "$qpi_numberOfPossessedShares", args: ["i64", "addr", "addr", "addr", "i32", "i32"], ret: "i64" },
  distributeDividends: { fwd: "$qpi_distributeDividends", args: ["i64"], ret: "i32" },
  dayOfWeek: { fwd: "$qpi_dayOfWeek", args: ["i32", "i32", "i32"], ret: "i32" },
  getEntity: { fwd: "$qpi_getEntity", args: ["addr", "addr"], ret: "i32" },
  isContractId: { fwd: "$qpi_isContractId", args: ["addr"], ret: "i32" },
  nextId: { fwd: "$qpi_nextId", args: ["addr"], ret: "out" },
  prevId: { fwd: "$qpi_prevId", args: ["addr"], ret: "out" },
  arbitrator: { fwd: "$qpi_arbitrator", args: [], ret: "out" },
  computor: { fwd: "$qpi_computor", args: ["i32"], ret: "out" },
};

// Map a single qpi argument to a forwarder operand by its declared kind.
function qpiOperand(ctx: FnCtx, expr: Expression, kind: ArgKind): string {
  if (kind === "i64") return emitValue(ctx, expr);
  if (kind === "i32") return `(i32.wrap_i64 ${emitValue(ctx, expr)})`;
  const a = emitAddr(ctx, expr);
  if (a) return a;
  ctx.cg.warn(`qpi argument is not an addressable id/struct`, (expr as any).span?.line ?? 0);
  return "(i32.const 0)";
}

// Build the forwarder operand list. "cidx" is injected; every other kind consumes one call arg.
function emitQpiOperands(ctx: FnCtx, args: Expression[], kinds: ArgKind[]): string[] {
  const ops: string[] = [];
  let ai = 0;
  for (const k of kinds) {
    if (k === "cidx") {
      ops.push("(call $qpi_contractIndex)");
      continue;
    }
    const e = args[ai++];
    if (!e) {
      ops.push(k === "addr" ? "(i32.const 0)" : "(i64.const 0)");
      continue;
    }
    ops.push(qpiOperand(ctx, e, k));
  }
  return ops;
}

interface QpiResult {
  wat: string;
  ret: "i64" | "i32" | "void" | "out";
}

// Lower a qpi.host(...) call. For "out" producers, outAddr receives the result (a scratch slot is
// allocated when none is supplied). Returns null if the call isn't a known qpi host call.
function emitQpiCall(ctx: FnCtx, expr: Expression & { kind: "call" }, outAddr?: string): QpiResult | null {
  if (!(expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi")) {
    return null;
  }
  const desc = QPI_CALLS[expr.callee.member];
  if (!desc) return null;

  const ops = emitQpiOperands(ctx, expr.args, desc.args);
  if (desc.ret === "out") {
    let out = outAddr;
    if (!out) {
      const t = newTmp(ctx);
      ctx.lines.push(`    (local.set $${t} (call $qpiAllocLocals (i32.const 32)))`);
      out = `(local.get $${t})`;
    }
    ops.push(out);
  }
  return { wat: `(call ${desc.fwd} ${ops.join(" ")})`, ret: desc.ret };
}

// ---- compiling instantiated container methods from the real qpi.h bodies ----

// A method parameter's wasm calling convention: references/pointers and aggregates pass by address (i32),
// scalars pass by value (i64).
function classifyMethodParam(cg: Codegen, p: ParamDecl, bind: Bindings): { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec } {
  const t = p.type;
  const isPtrOrRef = t.kind === "reference" || t.kind === "pointer";
  const deref = cg.derefType(t);
  const concrete = deref.kind === "name" && bind.types.has(deref.name) ? bind.types.get(deref.name)! : deref;
  const isAddr = isPtrOrRef || cg.isAggregateType(concrete);
  return { name: p.name, wasmType: isAddr ? "i32" : "i64", isAddr, type: t };
}

// Instantiate (or fetch from cache) a container method from its real qpi.h body, emitting a wasm
// function. Returns null if the body isn't captured or can't be lowered, so callers fall back.
function compileContainerMethod(cg: Codegen, type: TypeSpec & { kind: "template_instance" }, methodName: string): CompiledMethod | null {
  const def = cg.templateMethods.get(type.name)?.get(methodName);
  if (!def || !def.body) return null;

  const cacheKey = `${type.name}<${type.args.map((a) => cg.typeKeyOf(a)).join(",")}>::${methodName}`;
  const cached = cg.compiledMethods.get(cacheKey);
  if (cached) return cached;

  const bind = cg.bindContainer(type.name, type.args);
  const fnParams = (def.fnParams ?? []).map((p) => classifyMethodParam(cg, p, bind));
  const retDeref = cg.derefType(def.returnType);
  const retKind: "i64" | "void" = retDeref.kind === "void" ? "void" : (cg.isAggregateType(retDeref) ? "void" : "i64");

  const cm: CompiledMethod = { label: `$T${cg.compiledMethods.size}_${type.name}_${methodName}`, fnParams, retKind };
  cg.compiledMethods.set(cacheKey, cm);   // register before emitting so recursive/sibling calls resolve

  try {
    cg.emittedMethodOrder.push(emitTemplateMethod(cg, cm, def, type, bind));
  } catch (e: any) {
    cg.warn(`failed to compile ${cacheKey}: ${e.message}`, def.span?.line ?? 0);
    cg.compiledMethods.delete(cacheKey);
    return null;
  }
  return cm;
}

// Emit the wasm function for an instantiated container method: param $this + the method's own params,
// body lowered with a `this` context (bare members resolve to *this, types substituted via bindings).
function emitTemplateMethod(cg: Codegen, cm: CompiledMethod, def: FunctionTemplateDecl, type: TypeSpec & { kind: "template_instance" }, bind: Bindings): string {
  const thisLayout = cg.containerLayout(type.name, type.args);
  const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
  const ctx: FnCtx = {
    cg, state: empty, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: cm.retKind === "i64",
    thisLayout, thisType: type, thisBind: bind, staticConsts: cg.staticConstsOf(type.name, bind),
  };
  for (const p of cm.fnParams) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: cg.derefType(p.type) });

  if (def.body) collectLocals(def.body, ctx);
  if (def.body) emitStmt(ctx, def.body);

  const paramDecls = cm.fnParams.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = cm.retKind === "i64" ? " (result i64)" : "";
  const header = `  (func ${cm.label} (param $this i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  const tail = cm.retKind === "i64" ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
}

// Build a call to a container method compiled from its real qpi.h body. Arguments are classified from
// the method's own parameter list (reference/aggregate → address via argAddr, scalar → value). Returns
// the call WAT + compiled method, or null if the method isn't captured / can't be lowered.
function callCompiled(
  ctx: FnCtx, type: TypeSpec & { kind: "template_instance" }, method: string, self: string, args: Expression[],
): { call: string; cm: CompiledMethod } | null {
  const cm = compileContainerMethod(ctx.cg, type, method);
  if (!cm) return null;
  const bind = ctx.cg.bindContainer(type.name, type.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return fp.isAddr ? argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(fp.type), bind)) : emitValue(ctx, arg);
  });
  return { call: `(call ${cm.label} ${self}${ops.length ? " " + ops.join(" ") : ""})`, cm };
}

// Lower a container method call on a HashMap/HashSet/Array state/locals field. When valueWanted, returns
// the value WAT; otherwise pushes statement lines and returns "". Null if not a container call.
function emitContainerCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  if (!node || !node.type || node.type.kind !== "template_instance") return null;

  const map = node.addr;
  const member = expr.callee.member;
  const C = (n: number) => `(i32.const ${n})`;

  if (node.type.name === "HashMap" || node.type.name === "HashSet") {
    const isSet = node.type.name === "HashSet";
    const info = isSet ? ctx.cg.hashsetInfo(node.type.args) : ctx.cg.hashmapInfo(node.type.args);
    if (!info) return null;
    const dims = `${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.valOff!)} ${C(info.valSize!)} ${C(info.occBase!)}`;
    const indexOf = (k: string) => `(call $hm_index ${map} ${k} ${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.occBase!)} ${C(info.hashMode!)})`;
    const elemAt = (idx: Expression) => `(call $hm_elem ${map} (i32.and (i32.wrap_i64 ${emitValue(ctx, idx)}) ${C(info.L! - 1)}) ${C(info.elemSize)})`;

    // Prefer the method compiled from the real qpi.h body (HashMap and HashSet share the same impl
    // shape); the hand-written intrinsics are the fallback. Each argument is classified from the
    // method's own parameter list — reference and aggregate params are materialized to an address
    // (argAddr), scalars passed by value.
    const compiledHM = (m: string) => callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, m, map, expr.args);
    // Wire a compiled HashMap method that returns a value (or void): in value context return the call;
    // as a statement, drop a value result or push a void call directly. Returns true once handled.
    const wireCompiled = (m: string): boolean => {
      const c = compiledHM(m);
      if (!c) return false;
      if (valueWanted) { lastWired = c.call; return true; }
      ctx.lines.push(c.cm.retKind === "void" ? `    ${c.call}` : `    (drop ${c.call})`);
      lastWired = "";
      return true;
    };
    let lastWired = "";

    // queries (value context)
    if (member === "population" && valueWanted) return wireCompiled("population") ? lastWired : `(call $hm_population ${map} ${C(info.popOff!)})`;
    if (member === "capacity" && valueWanted) return `(i64.const ${info.L})`;
    if (member === "contains" && valueWanted) {
      if (wireCompiled("contains")) return lastWired;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      return `(i64.extend_i32_u (i32.ne ${indexOf(k)} (i32.const -1)))`;
    }
    if (member === "getElementIndex" && valueWanted) {
      if (wireCompiled("getElementIndex")) return lastWired;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      return `(i64.extend_i32_s ${indexOf(k)})`;
    }
    if (member === "nextElementIndex" && valueWanted) {
      if (wireCompiled("nextElementIndex")) return lastWired;
      return `(i64.extend_i32_s (call $hm_next ${map} (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L!)} ${C(info.occBase!)}))`;
    }
    if (member === "isEmptySlot" && valueWanted) {
      if (wireCompiled("isEmptySlot")) return lastWired;
      const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L! - 1)})`;
      return `(i64.extend_i32_u (i32.ne (call $hm_flag (i32.add ${map} ${C(info.occBase!)}) ${idx}) (i32.const 1)))`;
    }
    if (member === "value" && valueWanted) return loadAt(`(i32.add ${elemAt(expr.args[0])} ${C(info.valOff!)})`, info.valSize!);
    if (member === "key" && valueWanted && info.keySize! <= 8) return loadAt(elemAt(expr.args[0]), info.keySize!);

    // get(key, &value) — bool found, value copied out. The out parameter is a real lvalue (emitAddr),
    // not a materialized copy, so get keeps its explicit wiring rather than going through compiledHM.
    if (member === "get") {
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const out = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
      const cm = compileContainerMethod(ctx.cg, node.type, "get");
      const call = cm
        ? `(call ${cm.label} ${map} ${k} ${out})`
        : `(i64.extend_i32_u (call $hm_get ${map} ${k} ${out} ${dims} ${C(info.hashMode!)}))`;
      if (valueWanted) return call;
      ctx.lines.push(`    (drop ${call})`);
      return "";
    }

    // set (HashMap) / add (HashSet) both insert; add has no value.
    if (member === "set" || member === "add") {
      if (wireCompiled(member)) return valueWanted ? lastWired : "";
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = isSet ? k : argAddr(ctx, expr.args[1], info.valSize!);
      const call = `(i64.extend_i32_s (call $hm_set ${map} ${k} ${v} ${dims} ${C(info.popOff!)} ${C(info.hashMode!)}))`;
      if (valueWanted) return call;
      ctx.lines.push(`    (drop ${call})`);
      return "";
    }
    if (member === "removeByKey" || member === "remove") {
      if (wireCompiled(member)) return valueWanted ? lastWired : "";
      if (valueWanted) return null;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      ctx.lines.push(`    (call $hm_remove ${map} ${k} ${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.occBase!)} ${C(info.popOff!)} ${C(info.hashMode!)})`);
      return "";
    }
    if (member === "replace") {
      if (wireCompiled("replace")) return valueWanted ? lastWired : "";
      if (valueWanted) return null;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = argAddr(ctx, expr.args[1], info.valSize!);
      const t = newTmp(ctx);
      ctx.lines.push(`    (local.set $${t} ${indexOf(k)})`);
      ctx.lines.push(`    (if (i32.ge_s (local.get $${t}) (i32.const 0)) (then (call $copyMem (i32.add (call $hm_elem ${map} (local.get $${t}) ${C(info.elemSize)}) ${C(info.valOff!)}) ${v} ${C(info.valSize!)})))`);
      return "";
    }
    if (member === "reset" && !valueWanted) {
      if (wireCompiled("reset")) return "";
      ctx.lines.push(`    (call $hm_reset ${map} ${C(info.totalSize!)})`);
      return "";
    }
    // cleanup family is a no-op here (our probing never reclaims removed slots; lookups stay correct)
    if ((member === "cleanup" || member === "cleanupIfNeeded") && !valueWanted) return "";
    if (member === "needsCleanup" && valueWanted) return "(i64.const 0)";
  }

  if (node.type.name === "Array") {
    const info = ctx.cg.arrayInfo(node.type.args);
    if (!info) return null;
    const mask = info.L - 1;
    const aggr = isAggregate(ctx, info.elemType ?? null, info.elemSize);
    const elemAddr = (idx: Expression) =>
      `(i32.add ${map} (i32.mul (i32.and (i32.wrap_i64 ${emitValue(ctx, idx)}) ${C(mask)}) ${C(info.elemSize)}))`;

    if (member === "get" && valueWanted && !aggr) return loadAt(elemAddr(expr.args[0]), info.elemSize);
    if (member === "capacity" && valueWanted) return `(i64.const ${info.L})`;
    if (member === "set" && !valueWanted) {
      const ea = elemAddr(expr.args[0]);
      if (aggr) {
        const src = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
        ctx.lines.push(`    (call $copyMem ${ea} ${src} ${C(info.elemSize)})`);
      } else {
        ctx.lines.push(`    ${storeAt(ea, info.elemSize, emitValue(ctx, expr.args[1]))}`);
      }
      return "";
    }
    if (member === "setAll" && !valueWanted && !aggr) {
      // setAll(v): write v to every element. value scalar only (aggregate setAll is rare).
      const v = emitValue(ctx, expr.args[0]);
      const i = newTmp(ctx), val = newTmp(ctx);
      ctx.localVars.set(val, { wasmType: "i64" });
      ctx.lines.push(`    (local.set $${val} ${v})`);
      ctx.lines.push(`    (local.set $${i} (i32.const 0))`);
      ctx.lines.push(`    (block $sa_done (loop $sa`);
      ctx.lines.push(`      (br_if $sa_done (i32.ge_u (local.get $${i}) ${C(info.L)}))`);
      ctx.lines.push(`      ${storeAt(`(i32.add ${map} (i32.mul (local.get $${i}) ${C(info.elemSize)}))`, info.elemSize, `(local.get $${val})`)}`);
      ctx.lines.push(`      (local.set $${i} (i32.add (local.get $${i}) (i32.const 1)))`);
      ctx.lines.push(`      (br $sa)))`);
      return "";
    }
  }

  // Collection (priority queues over a per-PoV BST): every method is compiled from the real qpi.h body.
  // element(i)/pov(i) return the element value / its pov id — for a scalar element it flows as an i64
  // value here; an aggregate element (a struct) is an lvalue resolved by resolveContainerElem so
  // element(i).field chains (return null to fall through to that path).
  if (node.type.name === "Collection") {
    // cleanup compacts the backing arrays after many removals (a scratchpad BST rebuild using
    // reinterpret_cast/_tzcnt) — a no-op here, as with HashMap: lookups/iteration stay correct on the
    // uncompacted store, just slower.
    if ((member === "cleanup" || member === "cleanupIfNeeded") && !valueWanted) return "";
    if (member === "needsCleanup" && valueWanted) return "(i64.const 0)";
    if ((member === "element" || member === "pov") && valueWanted) {
      const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
      return c && c.cm.retKind === "i64" ? c.call : null;
    }
    const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
    if (!c) return null;
    if (valueWanted) return c.cm.retKind === "void" ? null : c.call;
    ctx.lines.push(c.cm.retKind === "void" ? `    ${c.call}` : `    (drop ${c.call})`);
    return "";
  }

  return null;
}

// QPI safe-math + helper free functions, lowered to scalar i64. smul/sadd/ssub are emitted as plain
// arithmetic (the saturating clamp only differs at the type's overflow boundary).
function emitMathCall(ctx: FnCtx, name: string, args: Expression[]): string | null {
  const a = () => (args[0] ? emitValue(ctx, args[0]) : "(i64.const 0)");
  const b = () => (args[1] ? emitValue(ctx, args[1]) : "(i64.const 0)");
  // accept a namespace-qualified spelling (math_lib::max, QPI::div, RL::min) — strip the qualifier.
  const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  switch (base) {
    case "div": case "sdiv": return `(call $m_div_s ${a()} ${b()})`;
    case "mod": return `(call $m_mod_s ${a()} ${b()})`;
    case "min": return `(call $m_min_s ${a()} ${b()})`;
    case "max": return `(call $m_max_s ${a()} ${b()})`;
    case "abs": return `(call $m_abs ${a()})`;
    case "sadd": return `(i64.add ${a()} ${b()})`;
    case "ssub": return `(i64.sub ${a()} ${b()})`;
    case "smul": return `(i64.mul ${a()} ${b()})`;
    default: return null;
  }
}

// Call to a contract value helper (toReturnCode(...)): scalar args by value, aggregate args by
// address. valueWanted → returns the i64 result; otherwise pushes the call as a statement.
function emitHelperCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (expr.callee.kind !== "identifier") return null;
  const info = ctx.cg.helpers.get(expr.callee.name);
  if (!info) return null;

  const ops = info.params.map((p, i) => {
    const arg = expr.args[i];
    if (!arg) return p.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return p.isAddr ? (emitAddr(ctx, arg) ?? "(i32.const 0)") : emitValue(ctx, arg);
  });
  const call = `(call ${info.label} ${ops.join(" ")})`;

  if (valueWanted) return info.retIsValue ? call : "(i64.const 0)";
  ctx.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
  return "";
}

// Inside a compiled container method: a call to a sibling method of *this (getElementIndex(key)) or the
// hash functor (HashFunc::hash(key)). Returns null when not applicable.
function emitThisCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (!ctx.thisType || ctx.thisType.kind !== "template_instance" || expr.callee.kind !== "identifier") return null;
  const name = expr.callee.name;

  // Structural-maintenance internals of Collection's BST, safe to skip — the store stays a correct (just
  // unbalanced/uncompacted) BST: _rebuild returns the subtree root unchanged; cleanup variants do nothing.
  // This avoids the scratchpad + SIMD (sint64_4 / reinterpret_cast / _tzcnt) rebuild path.
  if (name === "_rebuild") return expr.args[0] ? emitValue(ctx, expr.args[0]) : "(i64.const -1)";
  if ((name === "cleanup" || name === "cleanupIfNeeded") && !valueWanted) return "";
  if (name === "needsCleanup" && valueWanted) return "(i64.const 0)";

  // memory builtins used by container bodies: reset → setMem(this, ...); removeByIndex → setMem(&elem, ...).
  // Kept out of the contract surface (qpi.h hides them from contracts); valid only as statements here.
  if ((name === "setMem" || name === "copyMem") && !valueWanted) {
    const dst = emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)";
    if (name === "copyMem") {
      const src = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
      ctx.lines.push(`    (call $copyMem ${dst} ${src} (i32.wrap_i64 ${emitValue(ctx, expr.args[2])}))`);
    } else {
      ctx.lines.push(`    (call $setMem ${dst} (i32.wrap_i64 ${emitValue(ctx, expr.args[1])}) (i32.wrap_i64 ${emitValue(ctx, expr.args[2])}))`);
    }
    return "";
  }

  // HashFunc::hash(key) — for an id/m256i key the hash is its first 8 bytes; otherwise K12(key).
  if (name.endsWith("::hash")) {
    const keyAddr = emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)";
    const keyT = ctx.thisBind?.types.get("KeyT") ?? ctx.thisBind?.types.get("T");
    const keySize = keyT ? ctx.cg.sizeOfType(keyT, ctx.thisBind) : 32;
    if (keySize === 32) return `(i64.load ${keyAddr})`;
    const t = newTmp(ctx);
    ctx.lines.push(`    (local.set $${t} (call $qpiAllocLocals (i32.const 8)))`);
    ctx.lines.push(`    (call $qpi_k12 ${keyAddr} (i32.const ${keySize}) (local.get $${t}))`);
    return `(i64.load (local.get $${t}))`;
  }

  // a sibling method of this container instance — compile it and call with $this + args
  const cm = compileContainerMethod(ctx.cg, ctx.thisType, name);
  if (!cm) return null;
  const ops = cm.fnParams.map((fp, i) => {
    const arg = expr.args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return fp.isAddr ? (emitAddr(ctx, arg) ?? "(i32.const 0)") : emitValue(ctx, arg);
  });
  const call = `(call ${cm.label} (local.get $this) ${ops.join(" ")})`;
  if (valueWanted) return cm.retKind === "i64" ? call : "(i64.const 0)";
  ctx.lines.push(cm.retKind === "i64" ? `    (drop ${call})` : `    ${call}`);
  return "";
}

// rvalue call: a value helper, qpi getter, qpi valued host call, a value-returning container method,
// or a math helper.
function emitCallValue(ctx: FnCtx, expr: Expression & { kind: "call" }): string {
  const tc = emitThisCall(ctx, expr, true);
  if (tc !== null) return tc;

  const h = emitHelperCall(ctx, expr, true);
  if (h !== null) return h;

  if (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name") {
    const nm = expr.callee.kind === "identifier" ? expr.callee.name : `${expr.callee.namespace}::${expr.callee.name}`;
    const m = emitMathCall(ctx, nm, expr.args);
    if (m !== null) return m;
  }
  if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const g = QPI_GETTERS[expr.callee.member];
    if (g) return g.ret === "i64" ? `(call ${g.fwd})` : `(i64.extend_i32_u (call ${g.fwd}))`;
  }

  const q = emitQpiCall(ctx, expr);
  if (q) {
    if (q.ret === "i64") return q.wat;
    if (q.ret === "i32") return `(i64.extend_i32_u ${q.wat})`;
  }

  const c = emitContainerCall(ctx, expr, true);
  if (c !== null) return c;

  // Functional-style scalar cast: uint64(x) / sint64(x) / bit(x) ... — identity in the i64 value model
  // (matching the c_cast/static_cast lowering), narrowing handled by the consuming store.
  if (expr.callee.kind === "identifier" && SCALAR_SIZE[expr.callee.name] !== undefined && expr.args.length === 1) {
    return emitValue(ctx, expr.args[0]);
  }

  ctx.cg.warn(`unsupported call as value`, expr.span.line);
  return `(i64.const 0)`;
}

// statement call: a container mutation or a side-effecting qpi host call.
// Lower an inter-contract call to the host forwarder ($liteCallFunction / $liteInvokeProcedure). The
// callee contract index comes from the provided callee IDL (or a <NAME>_CONTRACT_INDEX constant); the
// entry's input-type number selects the function/procedure at that contract. IO sizes come from the
// in/out lvalues (falling back to the IDL). Returns null when the callee can't be resolved.
function emitInterContract(ctx: FnCtx, expr: Expression & { kind: "call" }, isInvoke: boolean): string | null {
  const cArg = expr.args[0], fArg = expr.args[1];
  if (cArg?.kind !== "identifier" || fArg?.kind !== "identifier") return null;
  const callee = ctx.cg.callees.get(cArg.name);
  let idx: number | null = callee?.index ?? null;
  if (idx === null) {
    const c = ctx.cg.resolveConst(`${cArg.name}_CONTRACT_INDEX`);
    if (c !== null) idx = Number(c);
  }
  const entry = isInvoke ? callee?.procedures[fArg.name] : callee?.functions[fArg.name];
  if (idx === null || !entry) return null;

  const inAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
  const outAddr = expr.args[3] ? (emitAddr(ctx, expr.args[3]) ?? "(i32.const 0)") : "(i32.const 0)";
  const inSize = (expr.args[2] ? resolveAddr(ctx, expr.args[2])?.size : undefined) ?? entry.inSize;
  const outSize = (expr.args[3] ? resolveAddr(ctx, expr.args[3])?.size : undefined) ?? entry.outSize;
  const dims = `(i32.const ${idx}) (i32.const ${entry.inputType}) ${inAddr} (i32.const ${inSize}) ${outAddr} (i32.const ${outSize})`;
  if (isInvoke) {
    const reward = expr.args[4] ? emitValue(ctx, expr.args[4]) : "(i64.const 0)";
    return `    (drop (call $liteInvokeProcedure ${dims} ${reward}))`;
  }
  return `    (drop (call $liteCallFunction ${dims}))`;
}

function emitCall(ctx: FnCtx, expr: Expression & { kind: "call" }): void {
  // LOG_* macros expand to __logContract{Info,Debug,...}Message — a side channel that does not affect
  // state or the digest, so dropping it is behaviorally faithful.
  if (expr.callee.kind === "identifier" && expr.callee.name.startsWith("__logContract")) return;

  // CALL(fn, in, out) → __qpi_call_self(fn, in, out): invoke a PRIVATE_ function of this contract,
  // passing the caller's in/out lvalues and a freshly bumped locals frame.
  if (expr.callee.kind === "identifier" && expr.callee.name === "__qpi_call_self") {
    const fnArg = expr.args[0];
    const info = fnArg?.kind === "identifier" ? ctx.cg.privates.get(fnArg.name) : undefined;
    if (info) {
      const inAddr = expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)";
      const outAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
      const locals = `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      ctx.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${locals})`);
      return;
    }
  }

  // CALL_OTHER_CONTRACT_FUNCTION(C,f,in,out) / INVOKE_OTHER_CONTRACT_PROCEDURE(C,p,in,out,reward) → a
  // host-mediated call into the contract at C's index. Needs C's callee IDL (index + entry input type).
  if (expr.callee.kind === "identifier" && (expr.callee.name === "__qpi_call_other" || expr.callee.name === "__qpi_invoke_other")) {
    const wat = emitInterContract(ctx, expr, expr.callee.name === "__qpi_invoke_other");
    if (wat) ctx.lines.push(wat);
    else ctx.cg.warn(`unsupported inter-contract call to '${expr.args[0]?.kind === "identifier" ? expr.args[0].name : "?"}' (no callee IDL)`, expr.span.line);
    return;
  }

  const tc = emitThisCall(ctx, expr, false);
  if (tc !== null) return;

  const h = emitHelperCall(ctx, expr, false);
  if (h !== null) return;

  const c = emitContainerCall(ctx, expr, false);
  if (c !== null) return;

  const q = emitQpiCall(ctx, expr);
  if (q) {
    if (q.ret === "void" || q.ret === "out") ctx.lines.push(`    ${q.wat}`);
    else ctx.lines.push(`    (drop ${q.wat})`);
    return;
  }

  ctx.cg.warn(`unsupported call statement`, expr.span.line);
}
