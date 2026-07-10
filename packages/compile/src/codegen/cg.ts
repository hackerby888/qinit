import { SCALAR_SIZE } from "./tables";
import { ClassTemplate, CompiledMethod, HelperInfo, PrivateInfo, CalleeIdl, StructLayout, CodegenWarning, NO_BIND, Bindings, FieldLayout, ContainerInfo } from "./types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";
import type { Sema } from "../sema";
import { parseIntLiteral as lexParseIntLiteral } from "../lexer";

export class Codegen {
  private sema: Sema;
  private nested: Map<string, StructDecl> = new Map();          // contract-local nested structs
  templates: Map<string, ClassTemplate> = new Map();            // qpi.h templates (HashMap, Array, ...)
  specializations: Map<string, { specArgs: TypeSpec[]; tmpl: ClassTemplate }[]> = new Map(); // partial/explicit specializations keyed by template name
  globalStructs: Map<string, StructDecl> = new Map();           // qpi.h global/namespace structs
  typedefs: Map<string, TypeSpec> = new Map();                  // typedef aliases
  constexprInit: Map<string, Expression> = new Map();           // named constexpr → its init expression
  enumConst: Map<string, bigint> = new Map();                   // enum constant (NAME and Type::NAME) → value
  enumSize: Map<string, number> = new Map();                    // enum type name → storage size from its underlying type (enum class X : uint8 → 1)
  enumNames: Set<string> = new Set();                           // every named enum type, for type-name resolution checks
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>> = new Map();  // Class → method → out-of-class def
  compiledMethods: Map<string, CompiledMethod> = new Map();     // instantiation cache key → compiled method
  emittedMethodOrder: string[] = [];                            // emitted WAT, in emission order (appended to module)
  private constCache: Map<string, bigint> = new Map();
  private constInProgress = new Set<string>();
  helpers: Map<string, HelperInfo> = new Map();    // value helpers: toReturnCode(...) etc.
  helperOverloads: Map<string, HelperInfo[]> = new Map();   // member value helpers, ALL overloads per name in declaration order; call sites rank by argument signature
  libFns: Map<string, FunctionDecl> = new Map();   // qpi.h namespace free functions (ProposalTypes::cls), keyed by qualified name; compiled lazily
  libFnTemplates: Map<string, FunctionTemplateDecl[]> = new Map();   // qpi.h namespace free function TEMPLATES (isArraySortedWithoutDuplicates<T,L>), all overloads kept, instantiated per call-site arg types
  privates: Map<string, PrivateInfo> = new Map();   // PRIVATE_FUNCTION/PROCEDURE called via CALL()
  registered: Map<string, PrivateInfo> = new Map(); // REGISTER_USER_* function/procedure, also reachable via CALL() (same entry shape)
  callees: Map<string, CalleeIdl> = new Map();      // other contracts callable via CALL_OTHER/INVOKE_OTHER (by state-type name)
  private layoutCache: Map<string, StructLayout> = new Map();
  contractStateLayout: StructLayout = { size: 0, align: 1, fields: new Map() };  // the contract's StateData (a ContractState& param in any function resolves through it)
  slot = 0;                                          // contract slot; oracle notification ids embed it ((slot << 22) | defLine)
  memberFnLine: Map<string, number> = new Map();     // contract member function name → definition line (__id_<proc> resolution)
  warnings: CodegenWarning[] = [];
  errors: CodegenWarning[] = [];

  constructor(sema: Sema) {
    this.sema = sema;
  }

  // ---- collect declarations from the whole TU (descends into namespaces) ----

  collectTU(decls: Declaration[], nsPrefix = ""): void {
    for (const d of decls) {
      if (d.kind === "namespace") {
        this.collectTU((d as any).body, `${nsPrefix}${(d as any).name}::`);
      } else if (d.kind === "struct") {
        const s = d as StructDecl;
        if (s.name) {
          this.globalStructs.set(s.name, s);
          // Inline value/void methods of a plain (non-template) struct — e.g. ProposalDataYesNo::checkValidity
          // — are captured under the struct name so an instance-method call dispatches through the same
          // per-type compilation path as template methods. (A template ProposalDataType like ProposalDataV1
          // already gets this via the class_template branch; a plain ProposalDataType did not, so its
          // checkValidity folded to 0 and every setProposal returned INVALID.)
          for (const m of s.members) {
            if (m.kind !== "function" || !(m as FunctionDecl).body) continue;
            const fn = m as FunctionDecl;
            if (fn.name === s.name || fn.name.startsWith("operator") || fn.name.startsWith("~")) continue;
            if (!this.templateMethods.has(s.name)) this.templateMethods.set(s.name, new Map());
            const into = this.templateMethods.get(s.name)!;
            const def: FunctionTemplateDecl = {
              kind: "function_template", name: fn.name, params: [], fnParams: fn.params,
              returnType: fn.returnType, body: fn.body, isConstexpr: fn.isConstexpr, span: fn.span,
            };
            // overloads (isValid() vs static isValid(y,m,d,...)) are additionally keyed by arity so an
            // arity-aware lookup picks the right one; the bare name keeps the first definition.
            const akey = `${fn.name}/${(fn.params ?? []).length}`;
            if (!into.has(akey)) into.set(akey, def);
            if (!into.has(fn.name)) into.set(fn.name, def);
          }
        }
        // file-scope structs can still nest constants/enums (e.g. a contract's static constexpr)
        this.collectConstants(s.members);
      } else if (d.kind === "class_template") {
        const ct = d as any;
        // A template may appear several times: a forward declaration (empty body), the primary definition,
        // and partial specializations. Specializations carry their own argument list and are selected by
        // matching the instantiation; the primary keeps the richest definition by member count so an empty
        // forward decl doesn't clobber the real layout. Base classes are carried so a template deriving
        // from another type contributes its fields.
        if (ct.specializationArgs) {
          if (!this.specializations.has(ct.name)) this.specializations.set(ct.name, []);
          this.specializations.get(ct.name)!.push({
            specArgs: ct.specializationArgs,
            tmpl: { params: ct.params, members: ct.members, bases: ct.bases },
          });
        } else {
          const existing = this.templates.get(ct.name);
          if (!existing || (ct.members?.length ?? 0) >= existing.members.length) {
            this.templates.set(ct.name, { params: ct.params, members: ct.members, bases: ct.bases });
          }
        }
        // Inline member methods defined with a body in the class itself (e.g. capacity()) are captured
        // as template methods, so they compile through the same per-type instantiation path as the
        // out-of-class (impl) definitions. Body-less declarations are skipped — their bodies live in
        // the impl chunk and are merged separately. A specialization's methods are not registered under
        // the shared name (they would collide with the primary's).
        for (const m of ct.specializationArgs ? [] : ct.members) {
          if (m.kind !== "function" || !(m as FunctionDecl).body) continue;
          const fn = m as FunctionDecl;
          if (!this.templateMethods.has(ct.name)) this.templateMethods.set(ct.name, new Map());
          const into = this.templateMethods.get(ct.name)!;
          const def: FunctionTemplateDecl = {
            kind: "function_template",
            name: fn.name,
            params: ct.params,
            fnParams: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            isConstexpr: fn.isConstexpr,
            span: fn.span,
          };
          const akey = `${fn.name}/${(fn.params ?? []).length}`;
          if (!into.has(akey)) into.set(akey, def);
          if (!into.has(fn.name)) into.set(fn.name, def);
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
          const minto = this.templateMethods.get(cls)!;
          const makey = `${method}/${(fn.fnParams ?? (fn as any).params ?? []).length}`;
          if (!minto.has(makey)) minto.set(makey, fn);
          if (!minto.has(method)) minto.set(method, fn);
        } else if (sep < 0 && nsPrefix && d.kind === "function" && (d as FunctionDecl).body) {
          // a namespace free function (ProposalTypes::cls, ProposalTypes::optionCount): keyed by its
          // qualified name so a `ProposalTypes::cls(type)` call resolves; compiled lazily on first use.
          const key = `${nsPrefix}${fn.name}`;
          if (!this.libFns.has(key)) this.libFns.set(key, d as FunctionDecl);
        } else if (sep < 0 && d.kind === "function_template" && fn.body) {
          // a namespace free function TEMPLATE (isArraySortedWithoutDuplicates<T,L>): keyed by qualified
          // name, instantiated per call-site arg types (the call passes a concrete Array<sint64,4>).
          // ALL overloads are kept — __getVotingSummaryScalarVotes has a generic body plus a
          // ProposalDataYesNo specialization, and the call site must pick by argument match.
          const key = `${nsPrefix}${fn.name}`;
          const list = this.libFnTemplates.get(key);
          if (list) list.push(fn as FunctionTemplateDecl);
          else this.libFnTemplates.set(key, [fn as FunctionTemplateDecl]);
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

  private collectEnum(e: { name?: string; underlyingType?: TypeSpec; members: { name: string; value?: Expression }[] }): void {
    if (e.name) {
      this.enumNames.add(e.name);
    }
    if (e.name && e.underlyingType?.kind === "name") {
      const sz = SCALAR_SIZE[e.underlyingType.name];
      if (sz !== undefined && !this.enumSize.has(e.name)) this.enumSize.set(e.name, sz);
    }
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
    if (init === undefined) {
      // A callee's index constant (`QX_CONTRACT_INDEX`) isn't declared in this contract's source, so resolve
      // it from the provided callee IDL. A plain-value use — `qpi.releaseShares(..., QX_CONTRACT_INDEX, ...)`
      // (MSVAULT) — otherwise folds to 0 and the managing-contract arg is wrong.
      const ci = name.match(/^(\w+)_CONTRACT_INDEX$/);
      if (ci) {
        const c = this.callees.get(ci[1]);
        if (c !== undefined) { this.constCache.set(name, BigInt(c.index)); return BigInt(c.index); }
      }
      // namespace-qualified constant (ProposalTypes::Class::GeneralOptions): constants are collected by their
      // unqualified name, so fall back to the tail after the last `::`.
      const i = name.lastIndexOf("::");
      return i >= 0 ? this.resolveConst(name.slice(i + 2)) : null;
    }
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

      const struct = this.structByName(t.name, b);
      if (struct) return this.layoutOfStruct(struct, b).size;

      const qn = this.qualifiedNestedType(t.name, b);
      if (qn) return this.sizeOfType(qn, b);

      // asset iterators occupy their 8-byte runtime shape (count @0, cursor @4) wherever they live
      if (/Asset(Ownership|Possession)Iterator$/.test(t.name)) return 8;

      // an enum type: sized by its declared underlying type (enum class X : uint8 → 1), default int
      const es = this.enumSize.get(t.name) ?? this.enumSize.get(t.name.split("::").pop()!);
      if (es !== undefined) return es;
      const num = parseInt(t.name);
      if (!isNaN(num)) return num; // shouldn't happen for a type, defensive
      return 4; // assume enum-sized
    }

    if (t.kind === "template_instance") {
      return this.layoutOfTemplate(t.name, t.args, b).size;
    }

    if (t.kind === "dependent_member") {
      const r = this.resolveDependentMember(t, b);
      if (r) return this.sizeOfType(r.type, r.bindings);
      return 0;
    }

    return 0;
  }

  // Resolve a dependent member type `Selector<args>::member` (e.g. ProposalVoting's
  // `typename __VoteStorageTypeSelector<supportScalarVotes>::type`): instantiate the selector template,
  // bind its parameters from the args, and return its nested `member` typedef's target type together with
  // those bindings. A captured full specialization whose non-type args match the evaluated args wins over
  // the primary template (so `<true>` -> sint64), otherwise the primary template is used.
  private resolveDependentMember(t: Extract<TypeSpec, { kind: "dependent_member" }>, b: Bindings): { type: TypeSpec; bindings: Bindings } | null {
    const base = t.base;
    if (base.kind !== "template_instance") return null;
    const inst = this.instantiateTemplate(base.name, base.args, b);
    if (!inst) return null;

    for (const m of inst.tmpl.members) {
      if (m.kind === "typedef_decl" && (m as any).name === t.member) {
        return { type: (m as any).type, bindings: inst.b };
      }
    }
    return null;
  }

  // Select the template definition for `name<args>` and build its parameter bindings. A partial/explicit
  // specialization whose argument pattern matches wins over the primary template (e.g.
  // `ProposalWithAllVoteData<ProposalDataYesNo, numOfVotes>`); its parameters bind by their position in the
  // specialization's own argument list, not by index in the primary's parameter list. Returns the chosen
  // definition together with its bindings, or null when no definition is captured.
  private instantiateTemplate(name: string, args: TypeSpec[], parent: Bindings): { tmpl: ClassTemplate; b: Bindings } | null {
    const resolved = args.map((a) => this.resolveType(a, parent));

    const specs = this.specializations.get(name);
    if (specs) {
      for (const spec of specs) {
        if (spec.specArgs.length !== resolved.length) continue;
        const paramByName = new Map(spec.tmpl.params.map((p) => [p.name, p] as const));
        const b: Bindings = { types: new Map(), values: new Map(), structs: new Map() };
        let match = true;
        for (let i = 0; i < spec.specArgs.length; i++) {
          const sa = spec.specArgs[i];
          const param = sa.kind === "name" ? paramByName.get(sa.name) : undefined;
          if (param) {
            // pattern variable — bind this specialization parameter to the instantiation argument
            if (param.kind === "type") b.types.set(param.name, resolved[i]);
            else b.values.set(param.name, this.evalConstFromType(resolved[i], parent));
          } else if (sa.kind === "name") {
            // concrete type to match: the argument must resolve to the same named type
            const ia = resolved[i];
            const iaName = ia.kind === "name" ? ia.name : ia.kind === "template_instance" ? ia.name : "";
            if (iaName !== sa.name) { match = false; break; }
          } else {
            if (this.evalConstFromType(resolved[i], parent) !== this.evalConstFromType(sa, parent)) { match = false; break; }
          }
        }
        if (match) return { tmpl: spec.tmpl, b: this.withStaticConsts(spec.tmpl, b) };
      }
    }

    // Templates register unqualified; a namespace-qualified spelling (QPI::ContractState<...>) must
    // still hit them.
    const tmpl = this.templates.get(name) ?? (name.includes("::") ? this.templates.get(name.slice(name.lastIndexOf("::") + 2)) : undefined);
    if (!tmpl) return null;
    const b: Bindings = { types: new Map(), values: new Map(), structs: new Map() };
    for (let i = 0; i < tmpl.params.length; i++) {
      const p = tmpl.params[i];
      const arg = resolved[i];
      if (!arg) continue;
      if (p.kind === "type") b.types.set(p.name, arg);
      else b.values.set(p.name, this.evalConstFromType(arg, parent));
    }
    return { tmpl, b: this.withStaticConsts(tmpl, b) };
  }

  // Evaluate a template's own static constexpr members into the bindings (BitArray::_elements = (L+63)/64,
  // ProposalWithAllVoteData::supportScalarVotes), so a member array dimension that references one sizes
  // correctly. Done in declaration order; a non-integer constexpr is skipped.
  private withStaticConsts(tmpl: ClassTemplate, b: Bindings): Bindings {
    for (const m of tmpl.members) {
      if (m.kind !== "variable") continue;
      const v = m as VariableDecl;
      if ((v.isStatic || v.isConstexpr) && v.init && !b.values.has(v.name)) {
        try {
          b.values.set(v.name, this.evalConstBig(v.init, b));
        } catch { /* non-integer constexpr (e.g. a typedef selector flag) — not a dimension */ }
      }
    }
    return b;
  }

  // Instantiate a template (HashMap<id,uint64,1024>, Array<T,L>, ...) and compute its exact layout
  // by substituting type args + non-type args into the captured member declarations.
  private layoutOfTemplate(name: string, args: TypeSpec[], parent: Bindings): StructLayout {
    const inst = this.instantiateTemplate(name, args, parent);
    const resolved = args.map((a) => this.resolveType(a, parent));
    if (!inst) {
      // Templates whose body we didn't capture: fall back to known formulas.
      return this.fallbackTemplateLayout(name, resolved, parent);
    }
    return this.layoutOfMembers(inst.tmpl.members, inst.b, `${name}<${resolved.map((r) => this.typeKey(r)).join(",")}>`, false, inst.tmpl.bases);
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

  // If a field's type names a sibling nested struct/union (registered in the local-struct scope), return it
  // as an inline_struct so the field's layout is self-describing. Without this, a member chain into a nested
  // type (proposal.data.transfer.amounts) fails: data's type `Data` is nested, so layoutOfType(name "Data")
  // can't find it globally and the chain dead-ends. inline_struct carries the decl, so each level resolves.
  private inlineNestedStruct(t: TypeSpec, b: Bindings): TypeSpec {
    const bare = t.kind === "const" ? t.valueType : t;
    if (bare.kind === "name") {
      const s = b.structs.get(bare.name);
      if (s) return { kind: "inline_struct", struct: s };
      // A dependent spelling through a template parameter (`typename OracleInterface::OracleReply`)
      // only resolves under these bindings — carry the resolved declaration inline for the same reason.
      const qn = this.qualifiedNestedType(bare.name, b);
      if (qn) return qn;
    }
    return t;
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

  // Resolve a type name to its concrete type, chasing both template-parameter bindings and contract/qpi
  // typedefs (e.g. ProposalVotingT -> ProposalVoting<...>, ProposalDataT -> ProposalDataV1<false>). Used
  // when binding template arguments, so an alias passed as an argument reaches the underlying type rather
  // than staying an unresolved name (which would leave a derived base or member sized as 0). Self-cycles
  // (a parameter bound to its own name) and a depth cap stop runaway chains.
  resolveType(t: TypeSpec, b: Bindings, depth = 0): TypeSpec {
    if (depth > 24 || t.kind !== "name") return t;
    const bound = b.types.get(t.name);
    if (bound && !(bound.kind === "name" && bound.name === t.name)) {
      return this.resolveType(bound, b, depth + 1);
    }
    const td = this.typedefs.get(t.name);
    if (td && !(td.kind === "name" && td.name === t.name)) {
      return this.resolveType(td, b, depth + 1);
    }
    const qn = this.qualifiedNestedType(t.name, b);
    if (qn) return qn;
    return t;
  }

  // Resolve a member/element type that is written in terms of a parent template instance's own parameters
  // and nested typedefs into a concrete type. Example: ProposalVoting<P,D>'s `proposals` element type is the
  // nested typedef `ProposalAndVotesDataType` = ProposalWithAllVoteData<ProposalDataT, maxVotes>, where
  // ProposalDataT is a parameter (→ D) and maxVotes a member constexpr (→ 676). emitContainerCall only
  // follows global typedefs, so without this a member that is itself a container/instance can't be dispatched.
  concreteMemberType(t: TypeSpec, parent: TypeSpec & { kind: "template_instance" }, depth = 0): TypeSpec {
    const inst = this.instantiateTemplate(parent.name, parent.args, NO_BIND);
    if (!inst) return t;
    const nested = new Map<string, TypeSpec>();
    for (const m of inst.tmpl.members) {
      if (m.kind === "typedef_decl") nested.set((m as any).name, (m as any).type);
    }
    return this.resolveInScope(t, inst.b, nested, depth);
  }

  private resolveInScope(t: TypeSpec, scope: Bindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
    if (depth > 24) return t;
    if (t.kind === "const") return { kind: "const", valueType: this.resolveInScope(t.valueType, scope, nested, depth + 1) };
    if (t.kind === "array") return { kind: "array", elem: this.resolveInScope(t.elem, scope, nested, depth + 1), size: t.size };
    if (t.kind === "name") {
      const bound = scope.types.get(t.name);
      if (bound && !(bound.kind === "name" && bound.name === t.name)) return this.resolveInScope(bound, scope, nested, depth + 1);
      const nt = nested.get(t.name);
      if (nt && !(nt.kind === "name" && nt.name === t.name)) return this.resolveInScope(nt, scope, nested, depth + 1);
      const td = this.typedefs.get(t.name);
      if (td && !(td.kind === "name" && td.name === t.name)) return this.resolveInScope(td, scope, nested, depth + 1);
      const qn = this.qualifiedNestedType(t.name, scope);
      if (qn) return qn;
      return t;
    }
    if (t.kind === "template_instance") {
      const args = t.args.map((a) => {
        // a non-type arg given as a name that resolves to a member constexpr / param value → its literal
        if (a.kind === "name" && scope.values.has(a.name)) {
          return { kind: "expr_value", expr: { kind: "int_literal", value: scope.values.get(a.name)!.toString(), span: { start: 0, end: 0, line: 0, col: 0 } } } as TypeSpec;
        }
        return this.resolveInScope(a, scope, nested, depth + 1);
      });
      return { kind: "template_instance", name: t.name, args };
    }
    return t;
  }

  // Public: substitute a type through bindings (T→sint64, L→4) — turns a template free fn's param type
  // `Array<T,L>` into the concrete `Array<sint64,4>` so its body's container calls resolve.
  substInBindings(t: TypeSpec, bind: Bindings): TypeSpec {
    return this.resolveInScope(t, bind, new Map(), 0);
  }

  // Public: recover the integer value of a (possibly value-) template arg, e.g. the `4` of Array<sint64,4>.
  valueOfTypeArg(t: TypeSpec, b: Bindings = NO_BIND): bigint {
    return this.evalConstFromType(t, b);
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
    }
    return 0n;
  }

  layoutOf(struct: StructDecl): StructLayout {
    return this.layoutOfStruct(struct, NO_BIND);
  }

  // A base class contributes its fields (laid out at the start of the derived object) and its static
  // constexpr constants. A derived member's array dimension may reference a base constant — e.g.
  // ProposalVoting : public P declares `proposals[P::maxProposals]` — so those constants must be lifted
  // into the derived scope. The base may itself be a template parameter (ProposalWithAllVoteData<D,n> :
  // public D), resolved here through the bindings.
  private baseContribution(baseType: TypeSpec, parentB: Bindings): { layout: StructLayout; consts: Map<string, bigint> } | null {
    let t: TypeSpec = baseType;
    if (t.kind === "name") {
      const bound = parentB.types.get(t.name);
      if (bound) t = bound;
      else {
        const td = this.typedefs.get(t.name);
        if (td) t = td;
      }
    }

    if (t.kind === "template_instance") {
      const tmpl = this.templates.get(t.name);
      if (!tmpl) return { layout: this.layoutOfTemplate(t.name, t.args, parentB), consts: new Map() };
      const b: Bindings = { types: new Map(), values: new Map(), structs: new Map() };
      const resolved = t.args.map((a) => this.resolveType(a, parentB));
      for (let i = 0; i < tmpl.params.length; i++) {
        const p = tmpl.params[i];
        const arg = resolved[i];
        if (!arg) continue;
        if (p.kind === "type") b.types.set(p.name, arg);
        else b.values.set(p.name, this.evalConstFromType(arg, parentB));
      }
      const consts = new Map<string, bigint>();
      for (const m of tmpl.members) {
        if (m.kind !== "variable") continue;
        const v = m as VariableDecl;
        if ((v.isStatic || v.isConstexpr) && v.init && !b.values.has(v.name)) {
          try {
            const val = this.evalConstBig(v.init, b);
            b.values.set(v.name, val);
            consts.set(v.name, val);
          } catch { /* a non-integer static constexpr (e.g. a bool selector) — not a dimension */ }
        }
      }
      const layout = this.layoutOfMembers(tmpl.members, b, `${t.name}<${resolved.map((r) => this.typeKey(r)).join(",")}>`, false, tmpl.bases);
      return { layout, consts };
    }

    if (t.kind === "name") {
      const struct = this.structByName(t.name, parentB);
      if (struct) {
        const consts = new Map<string, bigint>();
        for (const m of struct.members) {
          if (m.kind !== "variable") continue;
          const v = m as VariableDecl;
          if ((v.isStatic || v.isConstexpr) && v.init) {
            try { consts.set(v.name, this.evalConstBig(v.init, parentB)); } catch { /* not a dimension */ }
          }
        }
        const layout = this.layoutOfMembers(struct.members, parentB, this.structCacheKey(struct), struct.isUnion, struct.bases);
        return { layout, consts };
      }
    }
    return null;
  }

  // Evaluate a `TypeName::member` static constexpr. Resolves TypeName through the current bindings and
  // typedefs to a concrete struct or template instantiation, then evaluates that type's static constexpr
  // member in the type's own parameter scope (so e.g. ProposalAndVotingByComputors<N>::maxProposals == N).
  private evalQualifiedConst(typeName: string, member: string, b: Bindings): bigint | null {
    let t: TypeSpec = { kind: "name", name: typeName };
    for (let i = 0; i < 8 && t.kind === "name"; i++) {
      const bound = b.types.get(t.name);
      if (bound) { t = bound; continue; }
      const td = this.typedefs.get(t.name);
      if (td) { t = td; continue; }
      break;
    }

    let members: Declaration[] | null = null;
    let tb: Bindings = b;
    if (t.kind === "template_instance") {
      const tmpl = this.templates.get(t.name);
      if (!tmpl) return null;
      members = tmpl.members;
      tb = { types: new Map(), values: new Map(), structs: new Map() };
      const resolved = t.args.map((a) => this.resolveType(a, b));
      for (let i = 0; i < tmpl.params.length; i++) {
        const p = tmpl.params[i];
        const arg = resolved[i];
        if (!arg) continue;
        if (p.kind === "type") tb.types.set(p.name, arg);
        else tb.values.set(p.name, this.evalConstFromType(arg, b));
      }
    } else if (t.kind === "name") {
      const s = this.structByName(t.name, b);
      if (!s) return null;
      members = s.members;
    }
    if (!members) return null;

    for (const m of members) {
      if (m.kind !== "variable") continue;
      const v = m as VariableDecl;
      if (v.name === member && v.init) {
        try { return this.evalConstBig(v.init, tb); } catch { return null; }
      }
    }
    return null;
  }

  // A layout cache key unique to each struct DECLARATION, not its (possibly shared) name. Two distinct structs
  // can share a name — QBOND's state `Order` (…feeDebt) and `GetOrders_output::Order` (…price) — and caching by
  // bare name let the first computed layout satisfy lookups for the second (silently dropping the price field).
  private structKeys = new WeakMap<StructDecl, string>();
  private structKeyCounter = 0;
  private structCacheKey(struct: StructDecl): string {
    let k = this.structKeys.get(struct);
    if (k === undefined) {
      k = `${struct.name}#${this.structKeyCounter++}`;
      this.structKeys.set(struct, k);
    }
    return k;
  }

  private layoutOfStruct(struct: StructDecl, b: Bindings): StructLayout {
    return this.layoutOfMembers(struct.members, b, this.structCacheKey(struct), struct.isUnion, struct.bases);
  }

  private inProgress = new Set<string>();

  private bindingSig(b: Bindings): string {
    if (b.types.size + b.values.size === 0) return "";
    const ts = [...b.types].map(([k, v]) => `${k}=${this.typeKey(v)}`).join(",");
    const vs = [...b.values].map(([k, v]) => `${k}=${v}`).join(",");
    return `|${ts}|${vs}`;
  }

  private layoutOfMembers(members: Declaration[], bIn: Bindings, cacheKey: string, isUnion = false, bases: TypeSpec[] = []): StructLayout {
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
            fields.set(v.name, { name: v.name, offset: 0, size: sz, type: this.inlineNestedStruct(v.type, b) });
            if (sz > max) max = sz;
            if (al > maxAlign) maxAlign = al;
          }
        }
        const layout = { size: max, align: maxAlign, fields };
        if (key) this.layoutCache.set(key, layout);
        return layout;
      }

      // Base classes occupy the start of the object: each base's fields are placed at the current offset
      // and its static constexpr constants lifted into the bindings, so a following member's array
      // dimension that references one (e.g. `proposals[maxProposals]` over an inherited maxProposals)
      // resolves.
      let memberVals = b.values;
      for (const baseType of bases) {
        const bc = this.baseContribution(baseType, b);
        if (!bc) continue;
        offset = this.alignUp(offset, bc.layout.align);
        for (const bf of bc.layout.fields.values()) {
          fields.set(bf.name, { name: bf.name, offset: offset + bf.offset, size: bf.size, type: bf.type });
        }
        offset += bc.layout.size;
        if (bc.layout.align > maxAlign) maxAlign = bc.layout.align;
        if (bc.consts.size) {
          if (memberVals === b.values) memberVals = new Map(b.values);
          for (const [k, v] of bc.consts) if (!memberVals.has(k)) memberVals.set(k, v);
        }
      }

      // Nested typedefs (a template may alias its own params or define a dependent storage type, e.g.
      // ProposalVoting's `typedef ProposalWithAllVoteData<ProposalDataT, maxVotes> ProposalAndVotesDataType;`).
      // Register them so a member typed by the alias resolves; the alias target still references params and
      // member constexprs, which resolve lazily through the bindings.
      let memberTypes = b.types;
      for (const m of members) {
        if (m.kind !== "typedef_decl") continue;
        const td = m as any;
        if (memberTypes === b.types) memberTypes = new Map(b.types);
        if (!memberTypes.has(td.name)) memberTypes.set(td.name, td.type);
      }
      const bMem = (memberVals === b.values && memberTypes === b.types) ? b : { types: memberTypes, values: memberVals, structs: b.structs };

      for (const m of members) {
        // An anonymous struct/union (no name, no declarator) promotes its members into this struct at the
        // current offset (`union { Array<uint32,8> optionVoteCount; ... };` → optionVoteCount is a direct
        // field). Named nested structs are type definitions and are skipped; a `union X {...} x;` is a
        // regular variable member handled below.
        if (m.kind === "struct" && !(m as StructDecl).name) {
          const sub = this.layoutOfStruct(m as StructDecl, bMem);
          offset = this.alignUp(offset, sub.align);
          for (const f of sub.fields.values()) fields.set(f.name, { name: f.name, offset: offset + f.offset, size: f.size, type: f.type });
          offset += sub.size;
          if (sub.align > maxAlign) maxAlign = sub.align;
          continue;
        }
        if (m.kind !== "variable") continue;
        const v = m as VariableDecl;
        if (v.isStatic || v.isConstexpr) continue;
        const sz = this.sizeOfType(v.type, bMem);
        const align = Math.min(this.alignOfTypeB(v.type, bMem), 8);
        offset = this.alignUp(offset, align);
        fields.set(v.name, { name: v.name, offset, size: sz, type: this.inlineNestedStruct(v.type, bMem) });
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
      const struct = this.structByName(t.name, b);
      if (struct) return this.layoutOfStruct(struct, b).align;
      const es = this.enumSize.get(t.name) ?? this.enumSize.get(t.name.split("::").pop()!);
      if (es !== undefined) return es;
      return 4;
    }
    if (t.kind === "template_instance") {
      if (this.templates.get(t.name)) return this.layoutOfTemplate(t.name, t.args, b).align;
      if (t.name === "Array") return Math.min(this.alignOfTypeB(t.args[0], b), 8);
      return 8;
    }
    if (t.kind === "dependent_member") {
      const r = this.resolveDependentMember(t, b);
      if (r) return this.alignOfTypeB(r.type, r.bindings);
      return 1;
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
    // inline-carried struct as a template arg (Array<Order,256> resolved through its declaring scope):
    // key by tag + field names so same-named tags with different fields don't share a layout cache slot.
    if (t.kind === "inline_struct") {
      const fields = t.struct.members.filter((m) => m.kind === "variable").map((m) => (m as VariableDecl).name).join(",");
      return `s:${t.struct.name || "anon"}{${fields}}`;
    }
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
    try {
      return lexParseIntLiteral(value);
    } catch {
      return 0n;
    }
  }

  evalConstBig(expr: Expression, b: Bindings): bigint {
    switch (expr.kind) {
      case "int_literal":
        return this.parseIntLiteral(expr.value);
      case "bool_literal": return expr.value ? 1n : 0n;
      case "char_literal": return BigInt(expr.value);
      case "paren": return this.evalConstBig(expr.expr, b);
      case "identifier": {
        const v = b.values.get(expr.name);
        if (v !== undefined) return v;
        // Qualified static constexpr `T::member` (e.g. ProposalVoting's maxProposals =
        // ProposerAndVoterHandlingT::maxProposals): resolve T through the bindings/typedefs to a concrete
        // type and evaluate its static constexpr member in that type's own param scope.
        const sep = expr.name.lastIndexOf("::");
        if (sep > 0) {
          const q = this.evalQualifiedConst(expr.name.slice(0, sep), expr.name.slice(sep + 2), b);
          if (q !== null) return q;
        }
        const c = this.resolveConst(expr.name);
        if (c !== null) return c;
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
      case "call":
      case "template_call": {
        // QPI safe-math helpers appear in constexpr contexts (e.g. QUTIL_MAX_NEW_POLL = div(MAX_POLL, 4),
        // QRAFFLE_LOGOUT_FEE = div<uint32>(REGISTER_AMOUNT, 20)). The explicit-type form parses as a
        // template_call; both spellings must fold, else a div/mod/min/max silently becomes 0 and corrupts
        // the derived constant (and any fee, loop bound, or guard built on it).
        const callee = expr.callee;
        const fn = callee.kind === "identifier" ? callee.name : callee.kind === "qualified_name" ? callee.name : null;
        if (fn) {
          const a = expr.args.map((x) => this.evalConstBig(x, b));
          switch (fn) {
            case "div": return a[1] === 0n ? 0n : a[0] / a[1];
            case "mod": return a[1] === 0n ? 0n : a[0] % a[1];
            case "min": return a[0] <= a[1] ? a[0] : a[1];
            case "max": return a[0] >= a[1] ? a[0] : a[1];
            case "abs": return a[0] < 0n ? -a[0] : a[0];
          }
        }
        return 0n;
      }
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
        this.captureStructMethods(s, [s.name]);
        // Also register structs nested INSIDE this one under their qualified name (`Outer::Inner`), recursively.
        // The parser spells such a member type fully-qualified (`GetOrders_output::Order tempOrder;`), so without
        // this structByName's lossy unqualified-suffix fallback binds it to a same-named top-level struct with
        // different fields (QBOND's state `Order` has `feeDebt` where `GetOrders_output::Order` has `price`) —
        // silently dropping the field's stores, or (no match) sizing the type to 4 bytes.
        this.collectNestedStructs(s, s.name);
      } else if (m.kind === "variable") {
        this.collectConstant(m as VariableDecl);
      } else if (m.kind === "enum") {
        this.collectEnum(m as any);
      } else if (m.kind === "typedef_decl") {
        // contract-member typedef (typedef Order _Order;) — register the alias so _Order-typed locals
        // resolve their layout/fields.
        const td = m as any;
        if (!this.typedefs.has(td.name)) this.typedefs.set(td.name, td.type);
      } else if (m.kind === "class_template") {
        // contract-nested template struct (PULSE's HashMapConverter<Key,T,L>): register like a file-scope
        // template — the layout table AND its inline methods — so instantiations lay out and methods
        // dispatch through the compiled-container machinery.
        const ct = m as any;
        const prev = this.templates.get(ct.name);
        if (!prev || (prev.members?.length ?? 0) < (ct.members?.length ?? 0)) this.templates.set(ct.name, ct);
        for (const mm of ct.specializationArgs ? [] : ct.members) {
          if (mm.kind !== "function" || !(mm as FunctionDecl).body) continue;
          const fn = mm as FunctionDecl;
          if (!this.templateMethods.has(ct.name)) this.templateMethods.set(ct.name, new Map());
          const into = this.templateMethods.get(ct.name)!;
          const def: FunctionTemplateDecl = {
            kind: "function_template", name: fn.name, params: ct.params, fnParams: fn.params,
            returnType: fn.returnType, body: fn.body, isConstexpr: fn.isConstexpr, span: fn.span,
          };
          const akey = `${fn.name}/${(fn.params ?? []).length}`;
          if (!into.has(akey)) into.set(akey, def);
          if (!into.has(fn.name)) into.set(fn.name, def);
        }
      }
    }
  }

  // Register the struct members declared INSIDE `parent` under their qualified name `${prefix}::${name}`
  // (recursively), without clobbering same-named top-level structs. Lets `structByName("Outer::Inner")` hit
  // the correct inner declaration before the unqualified-suffix fallback.
  // Seed a callee contract's cross-contract surface (the pieces a single-TU native build gets for free
  // because all contracts share one translation unit): file-scope constants/enums (RL_DEFAULT_INIT_TIME)
  // and the contract struct's static methods, callable qualified (`RL::makeDateStamp`) through libFns.
  // Runs after the user's own declarations are collected — first-wins keeps the user authoritative.
  seedCallee(name: string, decls: Declaration[]): void {
    for (const d of decls) {
      if (d.kind === "variable") {
        this.collectConstant(d as VariableDecl);
      } else if (d.kind === "enum") {
        this.collectEnum(d as any);
      } else if (d.kind === "struct") {
        const s = d as StructDecl;
        if (!s.bases?.some((b) => b.kind === "name" && b.name === "ContractBase")) continue;
        for (const m of s.members) {
          if (m.kind !== "function") continue;
          const fn = m as FunctionDecl;
          if (!fn.body || !fn.isStatic) continue;
          const key = `${name}::${fn.name}`;
          if (!this.libFns.has(key)) this.libFns.set(key, fn);
        }
      }
    }
  }

  // Inline methods of a nested struct (WinnerData::isValid, EscrowAsset::setFrom) dispatch through
  // templateMethods like any plain-struct method — capture them under each of the given names,
  // additionally keyed by arity so overloads select correctly.
  private captureStructMethods(s: StructDecl, names: string[]): void {
    for (const mm of s.members) {
      if (mm.kind !== "function" || !(mm as FunctionDecl).body) continue;
      const fn = mm as FunctionDecl;
      if (fn.name === s.name || fn.name.startsWith("operator") || fn.name.startsWith("~")) continue;
      const def: FunctionTemplateDecl = {
        kind: "function_template", name: fn.name, params: [], fnParams: fn.params,
        returnType: fn.returnType, body: fn.body, isConstexpr: fn.isConstexpr, span: fn.span,
      };
      for (const cls of names) {
        if (!this.templateMethods.has(cls)) this.templateMethods.set(cls, new Map());
        const into = this.templateMethods.get(cls)!;
        const akey = `${fn.name}/${(fn.params ?? []).length}`;
        if (!into.has(akey)) into.set(akey, def);
        if (!into.has(fn.name)) into.set(fn.name, def);
      }
    }
  }

  private collectNestedStructs(parent: StructDecl, prefix: string): void {
    for (const m of parent.members) {
      if (m.kind === "struct") {
        const s = m as StructDecl;
        const key = `${prefix}::${s.name}`;
        if (!this.nested.has(key)) this.nested.set(key, s);
        // Also register the unqualified name so a bare reference written inside the declaring struct
        // (e.g. `Array<TableEntry, 512> info;` where TableEntry is a sibling nested struct) resolves.
        // First-wins and never shadowing a global keeps a same-named top-level/contract struct authoritative
        // (QBOND's state `Order` stays bound to itself, not GetOrders_output::Order).
        if (!this.nested.has(s.name) && !this.globalStructs.has(s.name)) this.nested.set(s.name, s);
        this.captureStructMethods(s, [s.name, key]);
        this.collectNestedStructs(s, key);
      }
    }
  }

  // ---- type → layout / field resolution (used by body codegen for address computation) ----

  alignOfType(t: TypeSpec, b: Bindings = NO_BIND): number {
    return this.alignOfTypeB(t, b);
  }

  // Resolve a struct by name across the binding / nested / global tables. Falls back to the unqualified
  // suffix so a namespace-qualified type (`QPI::Entity` under `using namespace QPI`) finds its layout —
  // without it, `entity.incomingAmount` became an unsupported member read folded to 0 (get_qubic_balance
  // then computed 0 - 0 and every voter balance read as 0).
  structByName(name: string, b: Bindings): StructDecl | undefined {
    const hit = b.structs.get(name) ?? this.nested.get(name) ?? this.globalStructs.get(name);
    if (hit) return hit;
    const i = name.lastIndexOf("::");
    if (i >= 0) {
      const u = name.slice(i + 2);
      return b.structs.get(u) ?? this.nested.get(u) ?? this.globalStructs.get(u);
    }
    return undefined;
  }

  // `Head::Nested[::Deeper]` where Head is a template-parameter binding, a typedef, or a (possibly
  // namespace-qualified) struct name (`typename OracleInterface::OracleReply` with OracleInterface →
  // OI::Price, or the spelled-out `OI::Mock::OracleQuery`): resolve the head struct at each possible
  // split point, then walk the remaining segments through its nested structs/typedefs to the member type.
  qualifiedNestedType(name: string, b: Bindings): TypeSpec | null {
    for (let sep = name.indexOf("::"); sep > 0; sep = name.indexOf("::", sep + 2)) {
      const head = name.slice(0, sep);
      const headT = b.types.get(head) ?? this.typedefs.get(head);
      let sd = headT ? this.structOf(headT, b) : this.structByName(head, b) ?? null;
      if (!sd) continue;

      const segs = name.slice(sep + 2).split("::");
      const walked = this.walkNestedSegments(sd, segs, b);
      if (walked) return walked;
    }
    return null;
  }

  private walkNestedSegments(sd: StructDecl | null, segs: string[], b: Bindings): TypeSpec | null {
    for (let i = 0; i < segs.length; i++) {
      if (!sd) return null;
      const seg = segs[i];
      const last = i === segs.length - 1;
      const ms = sd.members.find((m): m is StructDecl => m.kind === "struct" && m.name === seg);
      if (ms) {
        if (last) return { kind: "inline_struct", struct: ms, span: ms.span };
        sd = ms;
        continue;
      }
      const mt = sd.members.find((m) => m.kind === "typedef_decl" && (m as any).name === seg) as any;
      if (!mt) return null;
      if (last) return mt.type;
      sd = this.structOf(mt.type, b);
    }
    return null;
  }

  // Strip const/reference wrappers to the underlying type (a by-ref aggregate param holds an address
  // to this type, and its fields are laid out by this type).
  derefType(t: TypeSpec): TypeSpec {
    if (t.kind === "const") return this.derefType(t.valueType);
    if (t.kind === "reference") return this.derefType(t.refereed);
    return t;
  }

  // True for a void return type. The parser spells void two ways — a dedicated {kind:"void"} node and, on
  // some method paths, {kind:"name", name:"void"} — so a method like `void setupNewProposal(...)` must match
  // both, else it gets typed as returning i64 and its bare `return;` underflows the result stack.
  isVoidType(t: TypeSpec): boolean {
    const d = this.derefType(t);
    return d.kind === "void" || (d.kind === "name" && d.name === "void");
  }

  // True if a type is an aggregate (id/m256i/struct/array/container) — passed/returned by address
  // rather than as an i64 value. References and const are unwrapped first.
  isAggregateType(t: TypeSpec): boolean {
    if (t.kind === "const") return this.isAggregateType(t.valueType);
    if (t.kind === "reference") return this.isAggregateType(t.refereed);
    if (t.kind === "array" || t.kind === "inline_struct" || t.kind === "template_instance") return true;
    if (t.kind === "name") {
      if (t.name === "id" || t.name === "m256i" || t.name === "uint128" || t.name === "uint128_t") return true;
      if (SCALAR_SIZE[t.name] !== undefined) return false;
      return this.layoutOfType(t) !== null;
    }
    return false;
  }

  // Resolve a struct-ish type to its (cached) field layout, or null for scalars/containers.
  layoutOfType(t: TypeSpec, b: Bindings = NO_BIND): StructLayout | null {
    if (t.kind === "const") return this.layoutOfType(t.valueType, b);
    if (t.kind === "inline_struct") return this.layoutOfStruct(t.struct, b);
    if (t.kind === "template_instance") {
      return this.templates.get(t.name) ? this.layoutOfTemplate(t.name, t.args, b) : null;
    }
    if (t.kind === "name") {
      const bound = b.types.get(t.name);
      if (bound) return this.layoutOfType(bound, b);
      if (SCALAR_SIZE[t.name] !== undefined) return null;
      const td = this.typedefs.get(t.name);
      if (td) return this.layoutOfType(td, b);
      const s = this.structByName(t.name, b);
      if (s) return this.layoutOfStruct(s, b);
      const qn = this.qualifiedNestedType(t.name, b);
      if (qn) return this.layoutOfType(qn, b);
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
      const s = this.structByName(t.name, b);
      if (s) return s;
      const qn = this.qualifiedNestedType(t.name, b);
      return qn ? this.structOf(qn, b) : null;
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
    // A plain (non-template) struct dispatched as a zero-arg instance (ProposalDataYesNo, or a contract-
    // nested WinnerData) has no template entry — its `this` layout is the ordinary struct layout.
    if (!this.templates.has(name) && !this.specializations.has(name)) {
      const s = this.globalStructs.get(name) ?? this.nested.get(name);
      if (s) return this.layoutOfStruct(s, b);
    }
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
      else if (m.kind === "typedef_decl" && !out.types.has((m as any).name)) out.types.set((m as any).name, (m as any).type);
    }
    // Static constexpr members (supportScalarVotes, maxVotes, ...). Without these a method body that sizes a
    // dependent member type — `VoteStorageType = __VoteStorageTypeSelector<supportScalarVotes>::type` — can't
    // evaluate the selector argument and defaults to the wrong width (4 vs 1), unlike the struct layout which
    // already carries them. Mirrors layoutOfMembers' member-scope so body and layout agree.
    for (const m of tmpl.members) {
      if (m.kind !== "variable") continue;
      const v = m as VariableDecl;
      if ((v.isStatic || v.isConstexpr) && v.init && !out.values.has(v.name)) {
        try {
          out.values.set(v.name, this.evalConstBig(v.init, out));
        } catch {
          /* a const that can't be evaluated under these bindings is simply omitted */
        }
      }
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

  // Public: resolve a container/struct method to its body + the binding for the matched template instance,
  // HONORING PARTIAL SPECIALIZATIONS. ProposalWithAllVoteData<ProposalDataYesNo, N> is a specialization that
  // stores 2 bits per vote (votes[(2N+7)/8]) with its own set/setVoteValue/getVoteValue; the primary stores
  // one byte per vote. The layout already selects the specialization (instantiateTemplate matches it), so the
  // method body must come from the SAME instantiation — otherwise the primary's 1-byte access runs over the
  // specialization's bit-packed store and every unvoted slot reads as option 0. Falls back to the primary's
  // method table for methods defined OUT of the class body (HashMap::set), which the inline scan won't find.
  methodTemplate(name: string, args: TypeSpec[], methodName: string, argCount?: number): { def: FunctionTemplateDecl; bind: Bindings } | null {
    // bindContainer carries the full method-scope binding (params + nested typedefs like VoteStorageType +
    // static constexprs); instantiateTemplate's binding omits the nested typedefs, so the body's dependent
    // types would size to 0. The non-type param values (numOfVotes) match either way, so this binding is
    // correct for both the primary and a specialization that reuses the primary's parameter names.
    const bind = this.bindContainer(name, args);
    const inst = this.instantiateTemplate(name, args, NO_BIND);
    if (inst) {
      // Overload selection by arity (DateAndTime::isValid() vs the static isValid(y,m,d,...)): prefer an
      // exact parameter-count match, then one whose extra trailing params all have defaults, then first.
      const cands = inst.tmpl.members.filter(
        (mm) => mm.kind === "function" && (mm as FunctionDecl).name === methodName && (mm as FunctionDecl).body,
      ) as FunctionDecl[];
      let m: FunctionDecl | undefined = cands[0];
      if (argCount !== undefined && cands.length > 1) {
        m = cands.find((f) => (f.params ?? []).length === argCount)
          ?? cands.find((f) => (f.params ?? []).length > argCount && (f.params ?? []).slice(argCount).every((p) => p.defaultValue !== undefined))
          ?? cands[0];
      }
      if (m) {
        const fn = m as FunctionDecl;
        return {
          def: {
            kind: "function_template", name: fn.name, params: inst.tmpl.params, fnParams: fn.params,
            returnType: fn.returnType, body: fn.body, isConstexpr: fn.isConstexpr, span: fn.span,
          },
          bind,
        };
      }
    }
    const byName = this.templateMethods.get(name);
    const def = (argCount !== undefined ? byName?.get(`${methodName}/${argCount}`) : undefined) ?? byName?.get(methodName);
    return def && def.body ? { def, bind } : null;
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

  // Backing-store geometry for LinkedList<T, L>.element(i) = _nodes[i & (L-1)].value — offsets from
  // the parsed layout (the Node record is _nodes' array element type).
  linkedListInfo(args: TypeSpec[], b: Bindings = NO_BIND): { L: number; nodesOff: number; stride: number; valueOff: number; elemType: TypeSpec } | null {
    if (args.length < 2) return null;
    const L = Number(this.evalConstFromType(args[1], b));
    if (!L) return null;
    const nodesF = this.containerLayout("LinkedList", args, b).fields.get("_nodes");
    const bind = this.bindContainer("LinkedList", args, b);
    const nodeLayout = this.layoutOfType({ kind: "name", name: "Node" }, bind);
    const valueF = nodeLayout?.fields.get("value");
    if (!nodesF || !nodeLayout || !valueF) return null;
    return { L, nodesOff: nodesF.offset, stride: nodeLayout.size, valueOff: valueF.offset, elemType: args[0] };
  }

  warn(message: string, line: number): void {
    if ((globalThis as any).process?.env?.QINIT_WARN_TRACE && message.includes((globalThis as any).process.env.QINIT_WARN_TRACE) ) {
      console.error(new Error(`TRACE: ${message}`).stack);
    }
    this.warnings.push({ message, line });
  }

  // Hard semantic errors (not fidelity warnings): these abort the build regardless of strict
  // mode. Deduplicated because speculative emission may revisit the same node.
  error(message: string, line: number): void {
    if (this.errors.some((e) => e.message === message && e.line === line)) {
      return;
    }

    this.errors.push({ message, line });
  }
}
