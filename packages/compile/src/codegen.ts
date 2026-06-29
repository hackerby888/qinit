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
  constexprInit: Map<string, Expression> = new Map();           // named constexpr → its init expression
  enumConst: Map<string, bigint> = new Map();                   // enum constant (NAME and Type::NAME) → value
  private constCache: Map<string, bigint> = new Map();
  private constInProgress = new Set<string>();
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
        // typedef X Y — alias; resolve later via sizeOfType fallback
      }
    }
  }

  // ---- type → layout / field resolution (used by body codegen for address computation) ----

  alignOfType(t: TypeSpec, b: Bindings = NO_BIND): number {
    return this.alignOfTypeB(t, b);
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

  // Look up a field within a struct-ish type, returning its offset/size/type.
  fieldOf(t: TypeSpec, member: string, b: Bindings = NO_BIND): FieldLayout | null {
    const layout = this.layoutOfType(t, b);
    return layout ? layout.fields.get(member) ?? null : null;
  }

  // Concrete offsets/sizes for HashMap<K,V,L> matching the real qpi.h layout:
  //   Element _elements[L] @0 (key@0, value@valOff), _occupationFlags @occBase, _population @popOff.
  hashmapInfo(args: TypeSpec[], b: Bindings = NO_BIND): ContainerInfo | null {
    if (args.length < 3) return null;
    const keySize = this.sizeOfType(args[0], b);
    const valSize = this.sizeOfType(args[1], b);
    const L = Number(this.evalConstFromType(args[2], b));
    if (!L || keySize <= 0 || valSize <= 0) return null;
    const elemAlign = Math.max(this.alignOfType(args[0], b), this.alignOfType(args[1], b));
    const valOff = this.alignUp(keySize, this.alignOfType(args[1], b));
    const elemSize = this.alignUp(valOff + valSize, elemAlign);
    const elementsBytes = elemSize * L;
    const occBytes = Math.floor((L * 2 + 63) / 64) * 8;
    const occBase = elementsBytes;
    const popOff = elementsBytes + occBytes;
    const totalSize = popOff + 16; // _population + _markRemovalCounter
    const hashMode = keySize === 32 ? 0 : 1;
    return { kind: "HashMap", L, elemSize, keySize, valOff, valSize, occBase, popOff, totalSize, hashMode };
  }

  arrayInfo(args: TypeSpec[], b: Bindings = NO_BIND): ContainerInfo | null {
    if (args.length < 2) return null;
    const elemSize = this.sizeOfType(args[0], b);
    const L = Number(this.evalConstFromType(args[1], b));
    if (!L || elemSize <= 0) return null;
    return { kind: "Array", L, elemSize, elemType: args[0] };
  }

  warn(message: string, line: number): void {
    this.warnings.push({ message, line });
  }
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
}

// Parse-once: collect the qpi.h library type table (templates/structs/typedefs/constants) from its AST.
export function buildLibTypes(decls: Declaration[]): LibTypes {
  const cg = new Codegen({} as Sema);
  cg.collectTU(decls);
  return {
    templates: cg.templates,
    globalStructs: cg.globalStructs,
    typedefs: cg.typedefs,
    constexprInit: cg.constexprInit,
    enumConst: cg.enumConst,
  };
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
    for (const [k, v] of lib.constexprInit) cg.constexprInit.set(k, v);
    for (const [k, v] of lib.enumConst) cg.enumConst.set(k, v);
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

  // system procedures
  const sysprocs: SysProcInfo[] = [];
  let sysIdx = 0;
  for (const m of contract.members) {
    if (m.kind === "function") {
      const fn = m as FunctionDecl;
      const spId = SYSPROC_IMPL[fn.name];
      if (spId !== undefined) {
        const label = `$sys_${sysIdx++}`;
        userFns.push(emitFunction(cg, label, fn, stateLayout, { size: 0, align: 1, fields: new Map() }, { size: 0, align: 1, fields: new Map() }, { size: 0, align: 1, fields: new Map() }));
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
  tmpCount: number;
  loops: { brk: string; cont: string }[];   // innermost loop's break/continue labels are last
  loopCount: number;
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

    case "break":
      if (ctx.loops.length) ctx.lines.push(`    (br ${ctx.loops[ctx.loops.length - 1].brk})`);
      else ctx.cg.warn(`break outside loop`, stmt.span.line);
      break;

    case "continue":
      if (ctx.loops.length) ctx.lines.push(`    (br ${ctx.loops[ctx.loops.length - 1].cont})`);
      else ctx.cg.warn(`continue outside loop`, stmt.span.line);
      break;

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

// Emit an expression used as a statement (side effects only). Calls/assignments push their own
// lines to ctx; only inc/dec returns a WAT string for the caller to push.
function emitExprDrop(ctx: FnCtx, expr: Expression): string {
  if (expr.kind === "assign") return emitAssign(ctx, expr);
  if (expr.kind === "call") {
    emitCall(ctx, expr);
    return "";
  }
  if (expr.kind === "postfix_op" || expr.kind === "prefix_op") return emitIncDec(ctx, expr);
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

// Resolve the address of an lvalue expression (member-access chains rooted at input/output/locals/state).
function resolveAddr(ctx: FnCtx, expr: Expression): AddrNode | null {
  // roots
  if (expr.kind === "identifier") {
    if (expr.name === "input") return { addr: "(local.get $in)", type: null, size: ctx.in.size, layout: ctx.in };
    if (expr.name === "output") return { addr: "(local.get $out)", type: null, size: ctx.out.size, layout: ctx.out };
    if (expr.name === "locals") return { addr: "(local.get $locals)", type: null, size: ctx.locals.size, layout: ctx.locals };
    return null;
  }

  if (isStateAccessor(expr)) {
    return { addr: "(local.get $state)", type: null, size: ctx.state.size, layout: ctx.state };
  }

  // member access: resolve the object, then index its field
  if (expr.kind === "member_access") {
    const parent = resolveAddr(ctx, expr.object);
    if (!parent || !parent.layout) return null;
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
  if (expr.kind === "paren") return emitAddr(ctx, expr.expr);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") return emitAddr(ctx, expr.expr);

  // id(a,b,c,d) / m256i(a,b,c,d) constructor → materialize the four 64-bit limbs (missing ones = 0).
  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "id" || expr.callee.name === "m256i")) {
    return materializeId(ctx, expr.args);
  }
  // id::zero() / m256i::zero() → 32 zero bytes (X::y parses as one qualified identifier "X::y")
  if (expr.kind === "call" && expr.callee.kind === "identifier" &&
    (expr.callee.name === "id::zero" || expr.callee.name === "m256i::zero")) {
    return materializeId(ctx, []);
  }

  const n = resolveAddr(ctx, expr);
  return n ? n.addr : null;
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

  // local variable target
  if (expr.left.kind === "identifier" && ctx.localVars.has(expr.left.name)) {
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
      if (ctx.localVars.has(expr.name)) return `(local.get $${expr.name})`;
      if (expr.name === "SELF_INDEX") return `(i64.extend_i32_u (call $qpi_contractIndex))`;
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

// Lower a container method call on a HashMap/Array state/locals field. When valueWanted, returns the
// value WAT; otherwise pushes statement lines and returns "". Returns null if not a container call.
function emitContainerCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  if (!node || !node.type || node.type.kind !== "template_instance") return null;

  const map = node.addr;
  const member = expr.callee.member;
  const C = (n: number) => `(i32.const ${n})`;

  if (node.type.name === "HashMap" || node.type.name === "HashSet") {
    const info = ctx.cg.hashmapInfo(node.type.args);
    if (!info) return null;
    const dims = `${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.valOff!)} ${C(info.valSize!)} ${C(info.occBase!)}`;

    if (member === "population" && valueWanted) return `(call $hm_population ${map} ${C(info.popOff!)})`;
    if (member === "set" && !valueWanted) {
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = argAddr(ctx, expr.args[1], info.valSize!);
      ctx.lines.push(`    (drop (call $hm_set ${map} ${k} ${v} ${dims} ${C(info.popOff!)} ${C(info.hashMode!)}))`);
      return "";
    }
    if (member === "get" && !valueWanted) {
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const out = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
      ctx.lines.push(`    (drop (call $hm_get ${map} ${k} ${out} ${dims} ${C(info.hashMode!)}))`);
      return "";
    }
    if (member === "reset" && !valueWanted) {
      ctx.lines.push(`    (call $hm_reset ${map} ${C(info.totalSize!)})`);
      return "";
    }
    if (member === "contains" && valueWanted) {
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      return `(i64.extend_i32_u (i32.ne (call $hm_index ${map} ${k} ${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.occBase!)} ${C(info.hashMode!)}) (i32.const -1)))`;
    }
  }

  if (node.type.name === "Array") {
    const info = ctx.cg.arrayInfo(node.type.args);
    if (!info) return null;
    const mask = info.L - 1;
    const elemAddr = (idx: Expression) =>
      `(i32.add ${map} (i32.mul (i32.and (i32.wrap_i64 ${emitValue(ctx, idx)}) ${C(mask)}) ${C(info.elemSize)}))`;

    if (member === "get" && valueWanted) return loadAt(elemAddr(expr.args[0]), info.elemSize);
    if (member === "set" && !valueWanted) {
      const ea = elemAddr(expr.args[0]);
      if (isAggregate(ctx, info.elemType ?? null, info.elemSize)) {
        const src = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
        ctx.lines.push(`    (call $copyMem ${ea} ${src} ${C(info.elemSize)})`);
      } else {
        ctx.lines.push(`    ${storeAt(ea, info.elemSize, emitValue(ctx, expr.args[1]))}`);
      }
      return "";
    }
  }

  return null;
}

// QPI safe-math + helper free functions, lowered to scalar i64. smul/sadd/ssub are emitted as plain
// arithmetic (the saturating clamp only differs at the type's overflow boundary).
function emitMathCall(ctx: FnCtx, name: string, args: Expression[]): string | null {
  const a = () => (args[0] ? emitValue(ctx, args[0]) : "(i64.const 0)");
  const b = () => (args[1] ? emitValue(ctx, args[1]) : "(i64.const 0)");
  switch (name) {
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

// rvalue call: qpi getter, qpi valued host call, a value-returning container method, or a math helper.
function emitCallValue(ctx: FnCtx, expr: Expression & { kind: "call" }): string {
  if (expr.callee.kind === "identifier") {
    const m = emitMathCall(ctx, expr.callee.name, expr.args);
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

  ctx.cg.warn(`unsupported call as value`, expr.span.line);
  return `(i64.const 0)`;
}

// statement call: a container mutation or a side-effecting qpi host call.
function emitCall(ctx: FnCtx, expr: Expression & { kind: "call" }): void {
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
