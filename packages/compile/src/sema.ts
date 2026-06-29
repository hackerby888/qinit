// Semantic analysis: type checker, constexpr evaluator, template substitution engine.
// Operates on the unified AST from parser.ts.

import type {
  Span, TypeSpec, Expression, Statement, Declaration,
  StructDecl, ClassTemplateDecl, FunctionDecl, VariableDecl,
  EnumDecl, ParamDecl, TemplateParam, TranslationUnit,
  NamespaceDecl, AccessSpec,
} from "./ast";

export interface SemaDiagnostic {
  severity: "error" | "warning";
  message: string;
  span: Span;
}

// ---- Symbol table ----

export interface TypeInfo {
  kind: "struct" | "enum_class" | "enum_plain" | "typedef" | "builtin";
  name: string;
  size: number;             // sizeof in bytes
  alignment: number;
  fields: FieldInfo[];      // for structs
  underlyingType?: TypeSpec; // for enums
  enumerators: Map<string, bigint>;
  isTemplate: boolean;
  templateParams?: TemplateParam[];
  templateAst?: ClassTemplateDecl; // for lazy instantiation
}

export interface FieldInfo {
  name: string;
  type: TypeSpec;
  offset: number;
  size: number;
  access: AccessSpec;
}

export interface FuncInfo {
  name: string;
  returnType: TypeSpec;
  params: ParamDecl[];
  isConstexpr: boolean;
  isTemplate: boolean;
  templateParams?: TemplateParam[];
  ast?: FunctionDecl;
}

export interface VarInfo {
  name: string;
  type: TypeSpec;
  isConstexpr: boolean;
  init?: Expression;
}

class Scope {
  types: Map<string, TypeInfo> = new Map();
  funcs: Map<string, FuncInfo> = new Map();
  vars: Map<string, VarInfo> = new Map();
  parent: Scope | null;

  constructor(parent: Scope | null) {
    this.parent = parent;
  }

  lookupType(name: string): TypeInfo | null {
    const info = this.types.get(name);
    if (info) return info;
    return this.parent?.lookupType(name) ?? null;
  }

  lookupFunc(name: string): FuncInfo | null {
    const info = this.funcs.get(name);
    if (info) return info;
    return this.parent?.lookupFunc(name) ?? null;
  }

  lookupVar(name: string): VarInfo | null {
    const info = this.vars.get(name);
    if (info) return info;
    return this.parent?.lookupVar(name) ?? null;
  }
}

// Known builtin types and their sizes
const BUILTIN_SIZES: Record<string, { size: number; align: number }> = {
  "void": { size: 0, align: 1 },
  "bool": { size: 1, align: 1 },
  "bit": { size: 1, align: 1 },
  "sint8": { size: 1, align: 1 },
  "uint8": { size: 1, align: 1 },
  "signed char": { size: 1, align: 1 },
  "unsigned char": { size: 1, align: 1 },
  "sint16": { size: 2, align: 2 },
  "uint16": { size: 2, align: 2 },
  "signed short": { size: 2, align: 2 },
  "unsigned short": { size: 2, align: 2 },
  "sint32": { size: 4, align: 4 },
  "uint32": { size: 4, align: 4 },
  "signed int": { size: 4, align: 4 },
  "unsigned int": { size: 4, align: 4 },
  "sint64": { size: 8, align: 8 },
  "uint64": { size: 8, align: 8 },
  "signed long long": { size: 8, align: 8 },
  "unsigned long long": { size: 8, align: 8 },
  "long long": { size: 8, align: 8 },
  "uint128": { size: 16, align: 8 },
  "id": { size: 32, align: 8 },
  "m256i": { size: 32, align: 8 },
  "size_t": { size: 8, align: 8 },
  "unsigned long": { size: 8, align: 8 },
};

// ---- Sema ----

export class Sema {
  private _globalScope: Scope;
  private currentScope: Scope;
  private diagnostics: SemaDiagnostic[] = [];
  private qpiAst: TranslationUnit | null = null; // pre-parsed qpi.h AST

  // Expose for codegen access
  get globalScope(): Scope {
    return this._globalScope;
  }

  constructor() {
    this._globalScope = new Scope(null);
    this.currentScope = this._globalScope;
    for (const [name, { size, align }] of Object.entries(BUILTIN_SIZES)) {
      this._globalScope.types.set(name, {
        kind: "builtin",
        name,
        size,
        alignment: align,
        fields: [],
        enumerators: new Map(),
        isTemplate: false,
      });
    }
  }

  // Load pre-parsed qpi.h AST for template resolution
  loadQpiAst(ast: TranslationUnit): void {
    this.qpiAst = ast;
    // Register all declarations from qpi.h into global scope
    for (const decl of ast.declarations) {
      this.registerDecl(decl, this._globalScope);
    }
  }

  getDiagnostics(): SemaDiagnostic[] {
    return this.diagnostics;
  }

  error(msg: string, span: Span): void {
    this.diagnostics.push({ severity: "error", message: msg, span });
  }

  warn(msg: string, span: Span): void {
    this.diagnostics.push({ severity: "warning", message: msg, span });
  }

  // ---- Type resolution ----

  resolveType(type: TypeSpec): TypeInfo | null {
    if (type.kind === "name") {
      const builtin = BUILTIN_SIZES[type.name];
      if (builtin) {
        return {
          kind: "builtin",
          name: type.name,
          size: builtin.size,
          alignment: builtin.align,
          fields: [],
          enumerators: new Map(),
          isTemplate: false,
        };
      }
      return this.currentScope.lookupType(type.name) ?? this._globalScope.lookupType(type.name);
    }

    if (type.kind === "template_instance") {
      // Look up the template class
      const tmpl = this.currentScope.lookupType(type.name) ?? this._globalScope.lookupType(type.name);
      if (!tmpl || !tmpl.isTemplate) {
        this.error(`Unknown template class '${type.name}'`, type.span ?? { start: 0, end: 0, line: 0, col: 0 });
        return null;
      }
      // Instantiate the template (lazy — creates concrete TypeInfo)
      return this.instantiateTemplate(type.name, type.args, type.span);
    }

    if (type.kind === "const") {
      return this.resolveType(type.valueType);
    }

    if (type.kind === "pointer") {
      return { kind: "builtin", name: "i32", size: 4, alignment: 4, fields: [], enumerators: new Map(), isTemplate: false };
    }

    if (type.kind === "void") {
      return { kind: "builtin", name: "void", size: 0, alignment: 1, fields: [], enumerators: new Map(), isTemplate: false };
    }

    return null;
  }

  sizeofType(type: TypeSpec): number {
    const info = this.resolveType(type);
    return info?.size ?? 0;
  }

  // ---- Struct field access ----

  getFieldOffset(structType: TypeSpec, fieldName: string): number | null {
    const info = this.resolveType(structType);
    if (!info || info.kind !== "struct") return null;

    for (const f of info.fields) {
      if (f.name === fieldName) return f.offset;
    }

    // Check bases
    for (const f of info.fields) {
      if (f.name === fieldName) return f.offset;
    }

    return null;
  }

  getFieldSize(structType: TypeSpec, fieldName: string): number | null {
    const info = this.resolveType(structType);
    if (!info || info.kind !== "struct") return null;

    for (const f of info.fields) {
      if (f.name === fieldName) return f.size;
    }
    return null;
  }

  // ---- Constexpr evaluation ----

  evaluateConstexpr(expr: Expression): bigint | null {
    try {
      return this.evalExpr(expr);
    } catch {
      return null;
    }
  }

  private evalExpr(expr: Expression): bigint {
    switch (expr.kind) {
      case "int_literal": {
        const text = expr.value.replace(/ull?$/i, "").replace(/llu?$/i, "").replace(/[ul]$/i, "");
        if (text.startsWith("0x") || text.startsWith("0X")) return BigInt(text);
        if (text.startsWith("0b") || text.startsWith("0B")) return BigInt("0x" + BigInt(text.slice(2)).toString(16));
        if (text.startsWith("0") && text.length > 1) return BigInt("0x" + BigInt(text).toString(16));
        return BigInt(text);
      }
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
          case "*": throw new Error("cannot evaluate pointer deref at compile time");
          case "&": throw new Error("cannot evaluate address-of at compile time");
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
      case "sizeof_type":
        return BigInt(this.sizeofType(expr.type));
      case "sizeof_expr":
        throw new Error("sizeof(expr) not supported in constexpr eval");
      case "identifier": {
        // Look up constexpr variable
        const v = this.currentScope.lookupVar(expr.name) ?? this._globalScope.lookupVar(expr.name);
        if (v?.isConstexpr && v.init) return this.evalExpr(v.init);
        throw new Error(`unknown constexpr: ${expr.name}`);
      }
      case "c_cast":
      case "static_cast": {
        // Cast: evaluate inner, truncate to type size
        return this.evalExpr(expr.expr);
      }
      default:
        throw new Error(`constexpr eval not supported for ${expr.kind}`);
    }
  }

  // ---- Struct layout computation ----

  computeStructLayout(decl: StructDecl): FieldInfo[] {
    const fields: FieldInfo[] = [];
    let offset = 0;
    let maxAlign = 1;

    // Handle base class fields first
    for (const base of decl.bases) {
      const baseInfo = this.resolveType(base);
      if (baseInfo && baseInfo.kind === "struct") {
        for (const f of baseInfo.fields) {
          const align = f.size; // simplified alignment
          offset = this.alignTo(offset, align);
          fields.push({ ...f, offset, access: "public" });
          offset += f.size;
          if (align > maxAlign) maxAlign = align;
        }
      }
    }

    for (const member of decl.members) {
      if (member.kind === "variable") {
        const v = member as VariableDecl;
        const size = this.sizeofType(v.type);
        const align = Math.min(size, 8); // max alignment 8

        offset = this.alignTo(offset, align);
        fields.push({
          name: v.name,
          type: v.type,
          offset,
          size,
          access: v.access,
        });
        offset += size;
        if (align > maxAlign) maxAlign = align;
      }
    }

    return fields;
  }

  private alignTo(offset: number, align: number): number {
    return Math.ceil(offset / align) * align;
  }

  // ---- Template instantiation ----

  private templateInstances: Map<string, TypeInfo> = new Map();

  instantiateTemplate(name: string, args: TypeSpec[], span?: Span): TypeInfo | null {
    const key = `${name}<${args.map((a) => this.typeToKey(a)).join(",")}>`;

    // Check cache
    const cached = this.templateInstances.get(key);
    if (cached) return cached;

    // Find template definition
    const tmpl = this._globalScope.lookupType(name);
    if (!tmpl || !tmpl.isTemplate || !tmpl.templateAst) {
      this.error(`Template '${name}' not found or not instantiable`, span ?? { start: 0, end: 0, line: 0, col: 0 });
      return null;
    }

    // Build substitution bindings
    const bindings = new Map<string, TypeSpec>();
    const tparams = tmpl.templateParams ?? [];

    for (let i = 0; i < tparams.length && i < args.length; i++) {
      const p = tparams[i];
      if (p.kind === "type") {
        bindings.set(p.name, args[i]);
      } else if (p.kind === "non_type" || p.kind === "non_type_default") {
        // Non-type parameter — used for capacity constants, stored differently
        bindings.set(p.name, args[i]);
      }
    }

    // Compute concrete struct layout by substituting types
    const fields = this.instantiateStruct(tmpl.templateAst, bindings);
    const totalSize = fields.reduce((sum, f) => sum + f.size, 0);

    const info: TypeInfo = {
      kind: "struct",
      name: key,
      size: totalSize,
      alignment: 8,
      fields,
      enumerators: new Map(),
      isTemplate: false,
    };

    this.templateInstances.set(key, info);
    return info;
  }

  private typeToKey(type: TypeSpec): string {
    if (type.kind === "name") return type.name;
    if (type.kind === "template_instance") {
      return `${type.name}<${type.args.map((a) => this.typeToKey(a)).join(",")}>`;
    }
    if (type.kind === "void") return "void";
    if (type.kind === "pointer") return `*${this.typeToKey(type.pointee)}`;
    if (type.kind === "const") return `const ${this.typeToKey(type.valueType)}`;
    return "?";
  }

  private instantiateStruct(tmpl: ClassTemplateDecl, bindings: Map<string, TypeSpec>): FieldInfo[] {
    const fields: FieldInfo[] = [];
    let offset = 0;
    let maxAlign = 1;

    for (const member of tmpl.members) {
      if (member.kind === "variable") {
        const v = member as VariableDecl;
        const concreteType = this.substituteType(v.type, bindings);
        const size = this.sizeofType(concreteType);
        const align = Math.min(size, 8);

        offset = this.alignTo(offset, align);
        fields.push({
          name: v.name,
          type: concreteType,
          offset,
          size,
          access: v.access,
        });
        offset += size;
        if (align > maxAlign) maxAlign = align;
      }
    }

    return fields;
  }

  // ---- Type substitution ----

  substituteType(type: TypeSpec, bindings: Map<string, TypeSpec>): TypeSpec {
    if (type.kind === "name") {
      const bound = bindings.get(type.name);
      if (bound) return { ...bound, span: type.span };
      return type;
    }

    if (type.kind === "template_instance") {
      return {
        kind: "template_instance",
        name: type.name,
        args: type.args.map((a) => this.substituteType(a, bindings)),
        span: type.span,
      };
    }

    if (type.kind === "pointer") {
      return { kind: "pointer", pointee: this.substituteType(type.pointee, bindings), span: type.span };
    }

    if (type.kind === "const") {
      return { kind: "const", valueType: this.substituteType(type.valueType, bindings), span: type.span };
    }

    if (type.kind === "reference") {
      return { kind: "reference", refereed: this.substituteType(type.refereed, bindings), span: type.span };
    }

    return type;
  }

  // ---- Declaration registration ----

  registerDecl(decl: Declaration, scope: Scope): void {
    switch (decl.kind) {
      case "struct": {
        const s = decl as StructDecl;
        const fields = this.computeStructLayout(s);
        const totalSize = fields.reduce((sum, f) => sum + f.size, 0);

        scope.types.set(s.name, {
          kind: "struct",
          name: s.name,
          size: totalSize,
          alignment: 8,
          fields,
          enumerators: new Map(),
          isTemplate: false,
        });
        break;
      }

      case "class_template": {
        const ct = decl as ClassTemplateDecl;
        // Store the template AST — instantiation happens lazily
        scope.types.set(ct.name, {
          kind: "struct",
          name: ct.name,
          size: 0, // templates have no size until instantiated
          alignment: 8,
          fields: [],
          enumerators: new Map(),
          isTemplate: true,
          templateParams: ct.params,
          templateAst: ct,
        });
        break;
      }

      case "enum": {
        const e = decl as EnumDecl;
        const enumSize = this.sizeofType(e.underlyingType ?? { kind: "name", name: "uint32" });
        const enumerators = new Map<string, bigint>();

        for (const member of e.members) {
          if (member.value) {
            enumerators.set(member.name, this.evaluateConstexpr(member.value) ?? 0n);
          } else {
            // Auto-increment
            const prev = enumerators.size > 0 ?
              [...enumerators.values()][enumerators.size - 1] : -1n;
            enumerators.set(member.name, prev + 1n);
          }
        }

        if (e.name) {
          scope.types.set(e.name, {
            kind: e.isClass ? "enum_class" : "enum_plain",
            name: e.name,
            size: enumSize,
            alignment: Math.min(enumSize, 8),
            fields: [],
            underlyingType: e.underlyingType,
            enumerators,
            isTemplate: false,
          });
        }

        // Also register enumerator values as constexpr variables
        for (const [ename, eval_] of enumerators) {
          scope.vars.set(ename, {
            name: ename,
            type: { kind: "name", name: "uint64" },
            isConstexpr: true,
            init: { kind: "int_literal", value: eval_.toString(), span: decl.span },
          });
        }
        break;
      }

      case "variable": {
        const v = decl as VariableDecl;
        scope.vars.set(v.name, {
          name: v.name,
          type: v.type,
          isConstexpr: v.isConstexpr,
          init: v.init,
        });
        break;
      }

      case "function": {
        const f = decl as FunctionDecl;
        scope.funcs.set(f.name, {
          name: f.name,
          returnType: f.returnType,
          params: f.params,
          isConstexpr: f.isConstexpr,
          isTemplate: false,
          ast: f,
        });
        break;
      }

      case "function_template": {
        const ft = decl as any; // FunctionTemplateDecl
        scope.funcs.set(ft.name, {
          name: ft.name,
          returnType: ft.returnType,
          params: [],
          isConstexpr: ft.isConstexpr,
          isTemplate: true,
          templateParams: ft.params,
        });
        break;
      }

      case "namespace": {
        const ns = decl as NamespaceDecl;
        for (const inner of ns.body) {
          this.registerDecl(inner, scope);
        }
        break;
      }

      case "typedef_decl": {
        const td = decl as any; // TypedefDeclNode
        const resolved = this.resolveType(td.type);
        scope.types.set(td.name, {
          kind: "typedef",
          name: td.name,
          size: resolved?.size ?? 0,
          alignment: resolved?.alignment ?? 1,
          fields: resolved?.fields ?? [],
          enumerators: resolved?.enumerators ?? new Map(),
          isTemplate: false,
        });
        break;
      }

      case "static_assert_decl": {
        const sa = decl as any; // StaticAssertDecl
        const val = this.evaluateConstexpr(sa.cond);
        if (val === 0n) {
          const msg = sa.message?.kind === "string_literal" ? sa.message.value : "static_assert failed";
          this.error(`static_assert failed: ${msg}`, sa.span);
        }
        break;
      }

      // extern_block, friend, empty — nothing to register
      default:
        break;
    }
  }

  // ---- Entry point: analyze a contract translation unit ----

  analyze(tu: TranslationUnit): void {
    // First pass: register all declarations
    for (const decl of tu.declarations) {
      this.registerDecl(decl, this._globalScope);
    }

    // Second pass: validate (simplified for initial impl)
    // Full validation would check function bodies, resolve all types, etc.
  }

  // ---- Public helpers for codegen ----

  // Get the concrete StateData struct info after template instantiation
  getStateDataType(): TypeInfo | null {
    // Contracts define CONTRACT_STATE_TYPE which is the user's contract struct.
    // Its StateData nested struct is the on-chain state.
    const contractType = this._globalScope.lookupType("CONTRACT_STATE_TYPE");
    // CONTRACT_STATE_TYPE is #defined to the actual type name — look up that name
    // For Counter: CONTRACT_STATE_TYPE → Counter

    // The contract struct is registered with the configured name.
    // StateData is a nested struct inside it.
    // We also need resolved template instances for StateData fields.
    return null; // resolved during codegen
  }

  getAllTypes(): Map<string, TypeInfo> {
    const result = new Map<string, TypeInfo>();

    const collect = (scope: Scope) => {
      for (const [name, info] of scope.types) {
        result.set(name, info);
      }
    };

    collect(this._globalScope);
    collect(this.currentScope);

    for (const [name, info] of this.templateInstances) {
      result.set(name, info);
    }

    return result;
  }

  getAllFunctions(): Map<string, FuncInfo> {
    const result = new Map<string, FuncInfo>();

    const collect = (scope: Scope) => {
      for (const [name, info] of scope.funcs) {
        result.set(name, info);
      }
    };

    collect(this._globalScope);
    collect(this.currentScope);
    return result;
  }

  resolveEnumerator(typeName: string, valueName: string): bigint | null {
    const info = this._globalScope.lookupType(typeName) ?? this.currentScope.lookupType(typeName);
    if (!info) return null;
    return info.enumerators.get(valueName) ?? null;
  }
}

// (builtins initialized in constructor)
