// WAT codegen: walks the parsed contract AST and emits a complete WASM-text module.
// Computes real struct field offsets (scalars, id/m256i, uint128, nested POD structs,
// Array<T,L>, BitArray<L>). Container types (HashMap/HashSet/Collection/LinkedList) are
// sized best-effort and flagged — their exact layout needs the real qpi.h template bodies.

import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "./ast";
import type { Sema } from "./sema";
import { emitModule, type UserEntry, type SysProcInfo, type ModuleSpec } from "./framework";
import { parseIntLiteral as lexParseIntLiteral } from "./lexer";
import * as ir from "./ir";

interface ClassTemplate {
  params: TemplateParam[];
  members: Declaration[];
  bases?: TypeSpec[];
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
  __impl_preReleaseShares: 5,
  __impl_preAcquireShares: 6,
  __impl_postReleaseShares: 7,
  __impl_postAcquireShares: 8,
  __impl_postIncomingTransfer: 9,
};

// The scaffold renames a lifecycle procedure to its __impl_* name, but its locals struct keeps the macro
// spelling (END_EPOCH_locals, ...). Map the impl name back so the right locals frame is found.
const SYSPROC_LOCALS_PREFIX: Record<string, string> = {
  __impl_initialize: "INITIALIZE",
  __impl_beginEpoch: "BEGIN_EPOCH",
  __impl_endEpoch: "END_EPOCH",
  __impl_beginTick: "BEGIN_TICK",
  __impl_endTick: "END_TICK",
  __impl_preReleaseShares: "PRE_RELEASE_SHARES",
  __impl_preAcquireShares: "PRE_ACQUIRE_SHARES",
  __impl_postReleaseShares: "POST_RELEASE_SHARES",
  __impl_postAcquireShares: "POST_ACQUIRE_SHARES",
  __impl_postIncomingTransfer: "POST_INCOMING_TRANSFER",
};

// Share-transfer / incoming-transfer hooks carry real input (and, for the pre-* pair, output) structs —
// unlike the lifecycle procedures which are NoData both ways. The structs are qpi.h globals, so size them
// via layoutOfType (globalStructs), not the nested-only layoutFor.
const SYSPROC_IO: Record<string, { in?: string; out?: string }> = {
  __impl_preReleaseShares: { in: "PreManagementRightsTransfer_input", out: "PreManagementRightsTransfer_output" },
  __impl_preAcquireShares: { in: "PreManagementRightsTransfer_input", out: "PreManagementRightsTransfer_output" },
  __impl_postReleaseShares: { in: "PostManagementRightsTransfer_input" },
  __impl_postAcquireShares: { in: "PostManagementRightsTransfer_input" },
  __impl_postIncomingTransfer: { in: "PostIncomingTransfer_input" },
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
  specializations: Map<string, { specArgs: TypeSpec[]; tmpl: ClassTemplate }[]> = new Map(); // partial/explicit specializations keyed by template name
  globalStructs: Map<string, StructDecl> = new Map();           // qpi.h global/namespace structs
  typedefs: Map<string, TypeSpec> = new Map();                  // typedef aliases
  constexprInit: Map<string, Expression> = new Map();           // named constexpr → its init expression
  enumConst: Map<string, bigint> = new Map();                   // enum constant (NAME and Type::NAME) → value
  enumSize: Map<string, number> = new Map();                    // enum type name → storage size from its underlying type (enum class X : uint8 → 1)
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>> = new Map();  // Class → method → out-of-class def
  compiledMethods: Map<string, CompiledMethod> = new Map();     // instantiation cache key → compiled method
  emittedMethodOrder: string[] = [];                            // emitted WAT, in emission order (appended to module)
  private constCache: Map<string, bigint> = new Map();
  private constInProgress = new Set<string>();
  helpers: Map<string, HelperInfo> = new Map();    // value helpers: toReturnCode(...) etc.
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

  // `Head::Nested[::Deeper]` where Head is a template-parameter binding or typedef naming a struct
  // (`typename OracleInterface::OracleReply` with OracleInterface → OI::Price): resolve the head
  // struct, then walk the remaining segments through its nested structs/typedefs to the member type.
  qualifiedNestedType(name: string, b: Bindings): TypeSpec | null {
    const sep = name.indexOf("::");
    if (sep <= 0) return null;
    const headT = b.types.get(name.slice(0, sep)) ?? this.typedefs.get(name.slice(0, sep));
    if (!headT) return null;

    let sd = this.structOf(headT, b);
    const segs = name.slice(sep + 2).split("::");
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
}

interface HelperInfo {
  label: string;                                              // WAT function name ($h_<name>)
  params: { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; byValAgg?: boolean }[];
  retIsValue: boolean;                                        // returns a scalar i64 (vs void)
  retAgg?: number;                                            // returns an aggregate (id/struct) by value — its size; ABI prepends a $ret dest-address param
}

interface PrivateInfo {
  label: string;                                             // WAT function name ($priv_<name>)
  localsSize: number;                                        // sizeof(<name>_locals)
}

interface CompiledMethod {
  label: string;                                             // WAT function name ($T<n>_<Class>_<method>)
  fnParams: { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec }[];
  retKind: "i64" | "void";
  retAgg?: number;                                           // aggregate (id/struct) return size — ABI prepends a $ret dest-address param
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
  specializations: Map<string, { specArgs: TypeSpec[]; tmpl: ClassTemplate }[]>;
  libFns: Map<string, FunctionDecl>;
  libFnTemplates: Map<string, FunctionTemplateDecl[]>;
  globalStructs: Map<string, StructDecl>;
  typedefs: Map<string, TypeSpec>;
  constexprInit: Map<string, Expression>;
  enumConst: Map<string, bigint>;
  enumSize: Map<string, number>;
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>>;
}

// Parse-once: collect the qpi.h library type table (templates/structs/typedefs/constants/methods).
export function buildLibTypes(decls: Declaration[]): LibTypes {
  const cg = new Codegen({} as Sema);
  cg.collectTU(decls);
  return {
    templates: cg.templates,
    specializations: cg.specializations,
    libFns: cg.libFns,
    libFnTemplates: cg.libFnTemplates,
    globalStructs: cg.globalStructs,
    typedefs: cg.typedefs,
    constexprInit: cg.constexprInit,
    enumConst: cg.enumConst,
    enumSize: cg.enumSize,
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
  calleeStructs?: Map<string, StructDecl>,
  calleeTus?: Array<{ name: string; decls: Declaration[] }>,
  memBase?: number,
): string {
  const cg = new Codegen(sema);
  for (const c of callees ?? []) cg.callees.set(c.name, c);
  // Callee struct layouts, keyed by their qualified name (`QX::Fees_output`), so a caller reading a callee's
  // output type — `locals.qxFeesOutput.transferFee` — resolves its fields instead of folding to 0.
  if (calleeStructs) for (const [k, v] of calleeStructs) cg.globalStructs.set(k, v);

  // Seed the qpi.h library type table (templates / structs / typedefs) parsed once, then add
  // the user contract's own declarations on top.
  if (lib) {
    for (const [k, v] of lib.templates) cg.templates.set(k, v);
    if (lib.specializations) for (const [k, v] of lib.specializations) cg.specializations.set(k, [...v]);
    if (lib.libFns) for (const [k, v] of lib.libFns) cg.libFns.set(k, v);
    if (lib.libFnTemplates) for (const [k, v] of lib.libFnTemplates) cg.libFnTemplates.set(k, v);
    for (const [k, v] of lib.globalStructs) cg.globalStructs.set(k, v);
    for (const [k, v] of lib.typedefs) cg.typedefs.set(k, v);
    for (const [k, v] of lib.constexprInit) cg.constexprInit.set(k, v);
    for (const [k, v] of lib.enumConst) cg.enumConst.set(k, v);
    if (lib.enumSize) for (const [k, v] of lib.enumSize) cg.enumSize.set(k, v);
    if (lib.templateMethods) for (const [k, v] of lib.templateMethods) cg.templateMethods.set(k, new Map(v));
  }
  cg.collectTU(tu.declarations);
  for (const ct of calleeTus ?? []) cg.seedCallee(ct.name, ct.decls);

  const contract = findContractStruct(tu);
  if (!contract) {
    return emitModule({ stateSize: 0, arenaSize: arenaSz, entries: [], sysprocs: [], userFunctionsWat: ";; no contract struct found", memBase });
  }

  cg.collectNested(contract);
  cg.slot = slot;
  for (const m of contract.members) {
    if (m.kind === "function") cg.memberFnLine.set((m as FunctionDecl).name, (m as FunctionDecl).span?.line ?? 0);
  }

  // state size from StateData
  const stateData = cg["nested"].get("StateData");
  const stateLayout = stateData ? cg.layoutOf(stateData) : { size: 0, align: 1, fields: new Map() };
  const stateSize = stateLayout.size;
  cg.contractStateLayout = stateLayout;

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
        // A NON-const scalar reference (an out-param like `uint64& revenue`) must be passed by address so the
        // write reaches the caller — without this it was an i64 value param and `r = x` was lost (RL
        // getSCRevenue -> getBalance always 0). A const scalar reference (`const uint64&`) is read-only and can
        // bind to an rvalue at the call site, so it stays a value param (the $h_ call side passes it by value;
        // making it addr would need null-pointer/rvalue handling it doesn't have). Aggregates are addr either way.
        const isConstRef = p.type.kind === "reference" && p.type.refereed?.kind === "const";
        const isPtrRef = (p.type.kind === "reference" && !isConstRef) || p.type.kind === "pointer";
        const isAddr = isPtrRef || cg.isAggregateType(p.type);
        // A BY-VALUE aggregate param rides the by-address ABI but owns a private copy: the callee may mutate
        // it (MakePosKey's `id r` writes r.u64._3) and that write must NOT reach the caller's bytes.
        const byValAgg = isAddr && p.type.kind !== "reference" && p.type.kind !== "pointer";
        return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: cg.derefType(p.type), byValAgg };
      });
      const isVoid = cg.isVoidType(fn.returnType);   // `void` may parse as {kind:"void"} OR {kind:"name","void"}
      // size the referent for a `const T&` return — sizeOfType on the reference itself is pointer-width
      const retAgg = !isVoid && cg.isAggregateType(fn.returnType) ? cg.sizeOfType(cg.derefType(fn.returnType)) : undefined;
      const retIsValue = !isVoid && !retAgg;
      cg.helpers.set(fn.name, { label: `$h_${fn.name}`, params, retIsValue, retAgg });
      helperFns.push(fn);
    }
  }

  // Resolve a named I/O / locals struct to its layout, following typedefs and nested structs: a contract may
  // alias its entry types (`typedef Success_output Vote_output;`), so a direct nested-struct lookup misses and
  // output.* fields would resolve to nothing. layoutOfType chases the typedef to the real struct; a typedef to
  // an id/scalar (no field layout) falls back to a size-only layout so the body still passes it by address.
  const emptyL = () => ({ size: 0, align: 1, fields: new Map() });
  const resolveIO = (name: string) => {
    const s = cg["nested"].get(name);
    if (s) return cg.layoutOf(s);
    const lt = cg.layoutOfType({ kind: "name", name });
    if (lt) return lt;
    const sz = cg.sizeOfType({ kind: "name", name });
    return sz > 0 ? { size: sz, align: Math.min(sz, 8), fields: new Map() } : emptyL();
  };

  // Pre-pass: register every REGISTER_USER_* name -> {label, localsSize} before any body is emitted, so a
  // CALL() to a registered function/procedure resolves regardless of declaration order (a procedure may
  // CALL a function registered after it). The label `$user_${i}` is fixed by registration index.
  for (let i = 0; i < regs.length; i++) {
    cg.registered.set(regs[i].fnName, { label: `$user_${i}`, localsSize: resolveIO(`${regs[i].fnName}_locals`).size });
  }

  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i];
    const fn = findMemberFn(contract, reg.fnName);
    const inLayout = resolveIO(`${reg.fnName}_input`);
    const outLayout = resolveIO(`${reg.fnName}_output`);
    const localsLayout = resolveIO(`${reg.fnName}_locals`);

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
  // Follows typedefs to the real struct (fields included), then to a size-only layout for id/scalar aliases.
  const layoutFor = (name: string) => resolveIO(name);
  const layoutOfNamed = (name?: string) => {
    if (!name) return empty;
    return cg.layoutOfType({ kind: "name", name }) ?? empty;
  };

  // system procedures. Lifecycle procedures take no input/output but CAN declare locals (the
  // *_WITH_LOCALS forms, e.g. END_EPOCH where contracts run reward distribution) — give them their
  // <name>_locals frame so locals.* resolves, the same as user functions. Share-transfer / incoming-
  // transfer hooks additionally carry a qpi.h input struct (and the pre-* pair an output struct) so the
  // body's input.* / output.* field accesses resolve.
  const sysprocs: SysProcInfo[] = [];
  let sysIdx = 0;
  for (const m of contract.members) {
    if (m.kind === "function") {
      const fn = m as FunctionDecl;
      const spId = SYSPROC_IMPL[fn.name];
      if (spId !== undefined) {
        const label = `$sys_${sysIdx++}`;
        const localsLayout = layoutFor(`${SYSPROC_LOCALS_PREFIX[fn.name] ?? fn.name}_locals`);
        const io = SYSPROC_IO[fn.name];
        const inLayout = layoutOfNamed(io?.in);
        const outLayout = layoutOfNamed(io?.out);
        userFns.push(emitFunction(cg, label, fn, stateLayout, inLayout, outLayout, localsLayout));
        sysprocs.push({ id: spId, localsSize: localsLayout.size, inSize: inLayout.size, outSize: outLayout.size, label });
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
    memBase,
  };

  // expose warnings via a side channel (sema diagnostics)
  for (const w of cg.warnings) {
    sema.warn(w.message, { start: 0, end: 0, line: w.line, col: 0 }, "fidelity");
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
    const isNotif = method === "__registerUserProcedureNotification";
    if (!isFn && !isProc && !isNotif) continue;

    // args: (void*)fnName, inputType, sizeof(...), ...
    const fnArg = e.args[0];
    let fnName = "";
    if (fnArg?.kind === "c_cast" && fnArg.expr.kind === "identifier") fnName = fnArg.expr.name;
    else if (fnArg?.kind === "identifier") fnName = fnArg.name;

    const itArg = e.args[1];
    let inputType = 0;
    if (itArg?.kind === "int_literal") inputType = parseInt(itArg.value);

    // Notification procedure (oracle reply callback): its id arg is the synthetic __id_<proc>
    // ((CONTRACT_INDEX << 22) | defLine, qpi.h REGISTER_USER_PROCEDURE_NOTIFICATION). Dispatch matches
    // on the low 16 bits (lite_wasm_tu.h __registerUserProcedureNotification), which is just the
    // definition line — the shifted slot contributes nothing below bit 22.
    if (isNotif && fnName) {
      const def = contract.members.find((m) => m.kind === "function" && (m as FunctionDecl).name === fnName) as FunctionDecl | undefined;
      inputType = (def?.span?.line ?? 0) & 0xffff;
    }

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
  hasStateParam?: boolean;                    // this wasm function declares (param $state i32) — entry/private fns
  state: StructLayout;
  in: StructLayout;
  out: StructLayout;
  locals: StructLayout;
  localVars: Map<string, { wasmType: "i32" | "i64"; type?: TypeSpec }>;
  lines: string[];
  tmpCount: number;
  loops: { brk: string; cont: string }[];   // innermost loop's break/continue labels are last
  loopCount: number;
  params?: Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>;  // value-helper / method parameters (local overrides the wasm slot name when inlining)
  retIsValue?: boolean;                       // function returns a scalar value (return <expr>)
  retAddr?: string;                           // helper returns an aggregate (id/struct) by value: `return e` copies e here
  retAggSize?: number;                        // size of that aggregate return
  thisLayout?: StructLayout;                  // when compiling a container method: layout of *this
  thisType?: TypeSpec;                        // the container template_instance (HashMap<id,uint64,1024>)
  thisBind?: Bindings;                        // template-param bindings (KeyT→id, L→1024, ...) for the body
  staticConsts?: Map<string, bigint>;         // the container's static constexpr members (_nEncodedFlags, ...)
  gotoLabels?: Map<string, string>;           // C++ label name → enclosing wasm block label (forward goto)
  refLocals?: Map<string, TypeSpec>;          // reference/pointer locals: name → referent type (holds an address)
  scratchpadLocals?: Set<string>;             // __ScopedScratchpad locals: an i32 holding the scratch buffer base; `.ptr` reads it
  scratchpadScope?: string[];                 // scratchpads live in the current scope chain — released LIFO at compound exit
  thisAddr?: string;                           // WAT for *this's address (default "(local.get $this)"); set when inlining a struct method
  inlineMethod?: boolean;                       // emitting a struct method inline into the caller — `return` is suppressed (the value flows via thisAddr)
  proxyClass?: string;                          // emitting a ProposalVoting proxy method (qpi(pv).m()): the proxy class for sibling resolution
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
  const ctx: FnCtx = { cg, state, in: inL, out: outL, locals: localsL, localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0, hasStateParam: true };

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
function emitHelperFunction(cg: Codegen, info: HelperInfo, fn: { body?: Statement }, stateLayout: StructLayout, bind?: Bindings): string {
  const empty = { size: 0, align: 1, fields: new Map() };
  const ctx: FnCtx = {
    cg, state: stateLayout, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: info.retIsValue,
    // For an instantiated template free fn the body resolves T/L through these bindings (e.g. `L`→4).
    thisBind: bind,
  };
  // An aggregate-returning helper (`id liquidityPov(...)`) gets a leading $ret destination-address param;
  // `return e` copies the 32/N-byte value there. The caller allocates the slot and passes its address.
  if (info.retAgg) {
    ctx.retAddr = "(local.get $ret)";
    ctx.retAggSize = info.retAgg;
  }
  for (const p of info.params) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: p.type });

  if (fn.body) collectLocals(fn.body, ctx);

  // By-value aggregate params: bind the name to a private copy, so callee writes stay local (C++ value
  // semantics). The `local` override is honored at every param-address read.
  for (const p of info.params) {
    if (!p.byValAgg) continue;
    const size = cg.sizeOfType(p.type, bind ?? NO_BIND);
    if (!(size > 0)) continue;
    const cp = `bv_${p.name}`;
    ctx.localVars.set(cp, { wasmType: "i32" });
    ctx.lines.push(`    ${setLocal(ctx, cp, ir.call("$qpiAllocLocals", ir.i32c(size)))}`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", ir.getL(cp, "i32"), ir.getL(p.name, "i32"), ir.i32c(size)))}`);
    ctx.params!.get(p.name)!.local = cp;
  }

  const retParam = info.retAgg ? "(param $ret i32) " : "";
  const paramDecls = info.params.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = info.retIsValue ? " (result i64)" : "";
  const header = `  (func ${info.label} ${retParam}${paramDecls}${result}`.replace(/\s+\)/, ")");

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
      // A struct declared inside a function body (QUTIL setupNewProposal's `struct Shareholder {...}`) isn't in
      // globalStructs, so sizeof(Shareholder) and member offsets wouldn't resolve. Register it so the body's
      // pointer/subscript/member accesses see its layout. (Global registration is fine — names are unique here.)
      if (stmt.decl.kind === "struct") {
        const s = stmt.decl as StructDecl;
        if (s.name && !ctx.cg.globalStructs.has(s.name)) ctx.cg.globalStructs.set(s.name, s);
        break;
      }
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        // reference/pointer locals hold an address (i32); scalars use the i64 value model. A __ScopedScratchpad
        // or an Asset*Iterator local also holds an address (its scratch / iterator buffer base).
        const holdsAddr = v.type.kind === "name" && /(ScopedScratchpad|Iterator)$/.test(v.type.name);
        const b = ctx.thisBind ?? NO_BIND;

        // `auto` locals take their shape from the initializer: a cast supplies the full type
        // (auto* queue = reinterpret_cast<sint64_4*>(...)), a subscript of a typed pointer supplies
        // the element type (auto curRange = queue[i]). Undeduced auto stays a scalar.
        let dType = v.type;
        if (isAutoType(dType) && v.init) {
          const ci = castInfo(v.init);
          if (ci) {
            dType = ci.type;
          } else if (v.init.kind === "subscript" && v.init.object.kind === "identifier") {
            const ot = ctx.localVars.get(v.init.object.name)?.type;
            const op = ot ? resolveAliasType(ctx.cg, ot) : null;
            if (op?.kind === "pointer") {
              dType = op.pointee;
            }
          }
        }

        // A struct-typed local (DateAndTime begin = *this) lives in an allocated slot; its wasm local
        // holds the slot address so member reads and method dispatch resolve through it.
        const concrete = dType.kind === "name" && b.types.has(dType.name) ? b.types.get(dType.name)! : dType;
        const isAgg = !holdsAddr && dType.kind !== "reference" && dType.kind !== "pointer" && ctx.cg.isAggregateType(concrete);
        const isRef = dType.kind === "reference" || dType.kind === "pointer" || holdsAddr || isAgg;
        // In a ProposalVoting proxy method the `pv`/`qpi` aliases (`ProposalVotingType& pv = this->pv`) are
        // bound as the function's own parameters, not locals — skip them here.
        if (ctx.proxyClass && isRef && (v.name === "pv" || v.name === "qpi")) break;
        const wasmType: "i32" | "i64" = isRef ? "i32" : "i64";
        if (!ctx.localVars.has(v.name)) {
          ctx.localVars.set(v.name, { wasmType, type: resolveAliasType(ctx.cg, concrete) });
        }
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
  const spBase = ctx.scratchpadScope?.length ?? 0;
  // child index where each goto-targeted label is rooted
  const labelChild = new Map<string, number>();
  for (let i = 0; i < body.length; i++) {
    const labels = new Set<string>();
    collectLabelsIn(body[i], labels);
    for (const l of labels) if (!labelChild.has(l)) labelChild.set(l, i);
  }

  // forward gotos only: a label rooted in a later sibling than the goto. Each gets a block that ends right
  // before the label-bearing sibling; a `goto L` becomes `br $goto_L`. The block must enclose every goto to
  // L (so it opens at or before the earliest such goto) and close at the label.
  const wasmLabel = new Map<string, string>();
  const blocks: { wl: string; firstGoto: number; closeAt: number }[] = [];
  for (let i = 0; i < body.length; i++) {
    const gotos = new Set<string>();
    collectGotosIn(body[i], gotos);
    for (const g of gotos) {
      const lc = labelChild.get(g);
      if (lc === undefined || lc <= i || wasmLabel.has(g)) continue;
      const wl = `$goto_${g}_${ctx.loopCount++}`;
      wasmLabel.set(g, wl);
      blocks.push({ wl, firstGoto: i, closeAt: lc });
    }
  }

  if (wasmLabel.size === 0) {
    for (const s of body) emitStmt(ctx, s);
    return;
  }

  if (!ctx.gotoLabels) ctx.gotoLabels = new Map();
  for (const [g, wl] of wasmLabel) ctx.gotoLabels.set(g, wl);

  // WASM blocks must nest (LIFO). With multiple labels whose [firstGoto..closeAt] ranges OVERLAP without
  // containment (e.g. TransferSharesToManyV1's interleaved `goto insufficientShares` / `goto transferFailed`),
  // opening each at its own firstGoto produces an outer block that closes before an inner one — illegal, and
  // the earlier-closing block silently never closes at its label. Open ALL of them together at the earliest
  // firstGoto, ordered by closeAt descending (latest close = outermost). Wrapping a few extra leading siblings
  // is harmless (they fall through), and the nesting is always valid.
  const openChild = Math.min(...blocks.map((b) => b.firstGoto));
  blocks.sort((a, b) => b.closeAt - a.closeAt);
  const closeStack: number[] = [];
  for (let i = 0; i < body.length; i++) {
    while (closeStack.length && closeStack[closeStack.length - 1] === i) {
      ctx.lines.push(`    )`);
      closeStack.pop();
    }
    if (i === openChild) {
      for (const b of blocks) {
        ctx.lines.push(`    (block ${b.wl}`);
        closeStack.push(b.closeAt);
      }
    }
    emitStmt(ctx, body[i]);
  }
  while (closeStack.length) {
    ctx.lines.push(`    )`);
    closeStack.pop();
  }

  // Scope exit: run __ScopedScratchpad destructors declared in this compound (RAII, LIFO). Without the
  // release, sequential container cleanups within one dispatch sum their scratch instead of reusing it and
  // overrun the arena. (An early `return` skips these lines — that leak is bounded by the per-dispatch
  // arena reset.)
  if (ctx.scratchpadScope && ctx.scratchpadScope.length > spBase) {
    for (let i = ctx.scratchpadScope.length - 1; i >= spBase; i--) {
      ctx.lines.push(`    ${ir.emit(ir.call("$releaseScratchpad", ir.getL(ctx.scratchpadScope[i], "i32")))}`);
    }
    ctx.scratchpadScope.length = spBase;
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
        // The collect pass stored the declared type with `auto` resolved from the initializer;
        // classification here must agree with the wasm local type it chose.
        const declared = ctx.localVars.get(v.name)?.type ?? v.type;
        // __ScopedScratchpad scratchpad(size, initZero): bump a scratch buffer off the arena; the local holds
        // its base address, read back by `.ptr`. (release is a no-op — the arena resets per dispatch.)
        if (v.type.kind === "name" && /ScopedScratchpad$/.test(v.type.name)) {
          const args = v.init && (v.init.kind === "construct" || v.init.kind === "call") ? v.init.args : [];
          const size = args[0] ? emitValueIr(ctx, args[0]) : ir.i64c(0);
          const initZero = args[1] ? ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, args[1])) : ir.i32c(0);
          ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$acquireScratchpad", size, initZero))}`);
          (ctx.scratchpadLocals ??= new Set()).add(v.name);
          (ctx.scratchpadScope ??= []).push(v.name);
          break;
        }
        // AssetOwnership/PossessionIterator iter(asset): an 8-byte iterator buffer (count@0, cursor@4); the
        // constructor runs the enumerate. Track its type so iter.possessor()/reachedEnd()/next() dispatch.
        if (v.type.kind === "name" && /Asset(Ownership|Possession)Iterator$/.test(v.type.name)) {
          ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$qpiAllocLocals", ir.i32c(8)))}`);
          (ctx.refLocals ??= new Map()).set(v.name, v.type);
          const arg = v.init && (v.init.kind === "construct" || v.init.kind === "call") ? v.init.args[0] : undefined;
          if (arg) {
            emitAssetIter(ctx, {
              kind: "call", span: stmt.span, args: [arg],
              callee: { kind: "member_access", span: stmt.span, object: { kind: "identifier", name: v.name, span: stmt.span }, member: "begin" },
            } as Expression & { kind: "call" }, "stmt");
          }
          break;
        }
        // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it
        // resolves through that address. The referent type (Element, PoV, ...) drives field offsets. A pointer
        // keeps its pointer type (not the pointee) so `p[i]` subscripts.
        if (declared.kind === "reference" || declared.kind === "pointer") {
          // proxy `pv`/`qpi` aliases are already bound as parameters — drop the alias declaration.
          if (ctx.proxyClass && (v.name === "pv" || v.name === "qpi")) break;
          if (v.init) {
            const node = resolveAddr(ctx, v.init);
            // Fall back to emitAddr for initializers that aren't plain lvalues but still yield an address —
            // an asset-iterator getter (`const id& possessor = iter.possessor()`), an id producer, etc.
            const addr = node?.addr ?? emitAddr(ctx, v.init);
            if (addr) {
              if (!ctx.refLocals) ctx.refLocals = new Map();
              // A pointer local keeps its pointer type so resolveAddr's subscript path fires (`shareholders[i]`);
              // a reference binds to its referent type for direct member access.
              const refType = declared.kind === "pointer" ? declared : (node?.type ?? declared.refereed);
              ctx.refLocals.set(v.name, refType);
              ctx.lines.push(`    ${setLocal(ctx, v.name, addrIr(addr))}`);
            } else {
              ctx.cg.warn(`unsupported reference initializer for '${v.name}'`, stmt.span.line);
            }
          }
          break;
        }
        // struct-typed local (DateAndTime begin = *this): allocate a slot the wasm local points at, so
        // member reads and method dispatch on it resolve through an address. Copy-init from an lvalue /
        // materialized rvalue; a constructor-style init runs emitConstruct; otherwise zero-init (every
        // qpi.h default constructor zeroes its storage).
        {
          const db = ctx.thisBind ?? NO_BIND;
          const concrete = declared.kind === "name" && db.types.has(declared.name) ? db.types.get(declared.name)! : declared;
          if (ctx.cg.isAggregateType(concrete)) {
            // matches collectLocals' aggregate predicate: the wasm local is i32 (slot address), so this
            // branch must consume the declaration even when the size is unknown. An unsized array
            // (`const int daysInMonth[] = {...}`) takes its length from the initializer.
            let aggSz = ctx.cg.sizeOfType(concrete, db);
            if (concrete.kind === "array" && aggSz <= 0 && v.init?.kind === "initializer_list") {
              aggSz = ctx.cg.sizeOfType(concrete.elem, db) * (((v.init as any).exprs ?? []).length);
            }
            const sz = Math.max(aggSz, 8);
            ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$qpiAllocLocals", ir.i32c(sz)))}`);
            (ctx.refLocals ??= new Map()).set(v.name, concrete);
            const ctorArgs = v.init && (v.init.kind === "construct" || (v.init.kind === "call" && v.init.callee.kind === "identifier" && (v.init.callee as any).name === (v.type.kind === "name" ? v.type.name : ""))) ? (v.init as any).args : null;
            if (ctorArgs && emitConstruct(ctx, `(local.get $${v.name})`, concrete, ctorArgs)) {
              break;
            }
            // brace-init: array locals (const int daysInMonth[] = {0, 31, ...}) store element-wise;
            // struct locals go field-wise through emitConstruct.
            if (v.init?.kind === "initializer_list") {
              if (concrete.kind === "array") {
                const esz = ctx.cg.sizeOfType(concrete.elem, db);
                ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(v.name, "i32"), ir.i32c(sz), ir.i32c(0)))}`);
                ((v.init as any).exprs ?? []).forEach((e: Expression, i: number) => {
                  ctx.lines.push(`    ${ir.emit(ir.storeScalar(ir.addr0(ir.getL(v.name, "i32"), i * esz), esz, emitValueIr(ctx, e)))}`);
                });
                break;
              }
              if (emitConstruct(ctx, `(local.get $${v.name})`, concrete, (v.init as any).exprs ?? [])) {
                break;
              }
            }
            if (v.init) {
              const src = resolveAddr(ctx, v.init)?.addr ?? emitAddr(ctx, v.init);
              if (src) {
                ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", ir.getL(v.name, "i32"), addrIr(src), ir.i32c(sz)))}`);
                break;
              }
              ctx.cg.warn(`unsupported struct-local initializer for '${v.name}'`, stmt.span.line);
            }
            ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(v.name, "i32"), ir.i32c(sz), ir.i32c(0)))}`);
            break;
          }
        }
        if (v.init) {
          ctx.lines.push(`    ${setLocal(ctx, v.name, narrowLocalIr(ctx, v.name, emitValueIr(ctx, v.init)))}`);
        }
      }
      break;
    }

    case "if": {
      const cond = emitValue(ctx, stmt.cond);
      ctx.lines.push(`    (if (i64.ne (i64.const 0) ${cond}) (then`);
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
        ctx.lines.push(`      (br_if ${brk} (i64.eqz ${emitValue(ctx, stmt.cond)}))`);
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
      ctx.lines.push(`      (br_if ${brk} (i64.eqz ${emitValue(ctx, stmt.cond)}))`);
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
      ctx.lines.push(`      (br_if ${loop} (i64.ne (i64.const 0) ${emitValue(ctx, stmt.cond)}))))`);
      break;
    }

    case "switch": {
      const n = ctx.loopCount++;
      const brk = `$swbrk${n}`, sw = `sw${n}`;
      ctx.localVars.set(sw, { wasmType: "i64" });
      ctx.lines.push(`    ${setLocal(ctx, sw, emitValueIr(ctx, stmt.cond))}`);
      ctx.lines.push(`    (block ${brk}`);
      // break targets the switch; continue still targets the enclosing loop (if any).
      const cont = ctx.loops.length ? ctx.loops[ctx.loops.length - 1].cont : brk;
      ctx.loops.push({ brk, cont });
      const body = stmt.body.kind === "compound" ? stmt.body.body : [stmt.body];

      // Group statements by case/default markers. Each group gets a block label so
      // dispatch can branch to it, and fallthrough works naturally: a body without an
      // explicit break exits its enclosing block and lands on the next body in source order.
      const groups: { test: string | null; stmts: Statement[]; label: string }[] = [];
      let caseIdx = 0;
      for (const s of body) {
        if (s.kind === "case") {
          groups.push({
            test: `(i64.eq (local.get $${sw}) ${emitValue(ctx, s.value)})`,
            stmts: [],
            label: `$swcase${n}_${caseIdx++}`,
          });
        } else if (s.kind === "default") {
          groups.push({ test: null, stmts: [], label: `$swdef${n}` });
        } else if (groups.length) {
          groups[groups.length - 1].stmts.push(s);
        }
      }

      // Open blocks from last group (outermost) to first (innermost) so that the
      // dispatch, placed inside all of them, can br to any case/default label.
      for (let i = groups.length - 1; i >= 0; i--) {
        ctx.lines.push(`      (block ${groups[i].label}`);
      }

      // Dispatch chain — one conditional branch per non-default case.
      for (const g of groups) {
        if (g.test) {
          ctx.lines.push(`        (if ${g.test} (then (br ${g.label})))`);
        }
      }

      // No match falls through to default group if one exists, otherwise breaks.
      const defaultGroup = groups.find((g) => g.test === null);
      ctx.lines.push(`        (br ${defaultGroup ? defaultGroup.label : brk})`);

      // Close blocks in source order, emitting each body between block boundaries.
      // After a body without a break, control naturally exits the enclosing block
      // and reaches the next body — reproducing C++ fallthrough.
      for (const g of groups) {
        ctx.lines.push(`      )`);
        for (const s of g.stmts) {
          emitStmt(ctx, s);
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
      if (stmt.value && ctx.retAddr) {
        // aggregate-returning helper: copy the returned value into the caller-supplied dest, then return
        const src = emitAddr(ctx, stmt.value);
        if (src) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(ctx.retAddr!), addrIr(src), ir.i32c(ctx.retAggSize!)))}`);
        ctx.lines.push(`    (return)`);
      } else if (stmt.value && ctx.retIsValue) {
        ctx.lines.push(`    (return ${emitValue(ctx, stmt.value)})`);
      } else {
        ctx.lines.push(`    (return)`);
      }
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
    // uint128: a scalar load-modify-store touches only the low limb and loses the carry/borrow —
    // route through the $u128_* helpers instead (uint128.h operator++ carries across limbs).
    if (isUint128(ctx.cg, addr.type ?? null)) {
      const one = allocSlotIr(ctx, 16);
      ctx.lines.push(`    ${ir.emit(ir.call("$u128_set", one, ir.i64c(1), ir.i64c(0)))}`);
      const res = allocSlotIr(ctx, 16);
      ctx.lines.push(`    ${ir.emit(ir.call(op === "i64.add" ? "$u128_add" : "$u128_sub", res, addrIr(addr.addr), one))}`);
      return ir.emit(ir.call("$copyMem", addrIr(addr.addr), res, ir.i32c(16)));
    }
    const load = loadAt(addr.addr, addr.size, isSignedScalarType(addr.type));
    const stored = `(${op} ${load} (i64.const 1))`;
    return storeAt(addr.addr, addr.size, stored);
  }
  return "";
}

// ---- lvalue addressing ----

interface Lvalue {
  addr: string;                 // WAT producing the i32 byte address
  size: number;                 // field size in bytes
  type?: TypeSpec | null;       // pointee type when known — drives signed sub-64-bit load extension
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
// Normalize a cast expression to its target type + operand. C++ casts parse either as a dedicated node
// (c_cast / static_cast / reinterpret_cast) or as a `template_call` to the cast name (static_cast<T>(e)).
function castInfo(e: Expression): { type: TypeSpec; operand: Expression } | null {
  if (e.kind === "static_cast" || e.kind === "c_cast" || e.kind === "reinterpret_cast") return { type: e.type, operand: e.expr };
  if (e.kind === "template_call" && e.callee.kind === "identifier" && /^(static|reinterpret|const)_cast$/.test(e.callee.name) && e.templateArgs?.[0] && e.args?.[0]) {
    return { type: e.templateArgs[0], operand: e.args[0] };
  }
  return null;
}

function stripPtrRefConst(t: TypeSpec): TypeSpec {
  while (t.kind === "pointer" || t.kind === "reference" || t.kind === "const") {
    t = t.kind === "pointer" ? t.pointee : t.kind === "reference" ? t.refereed : t.valueType;
  }
  return t;
}

function resolveAddr(ctx: FnCtx, expr: Expression): AddrNode | null {
  // __ScopedScratchpad.ptr → the held scratch buffer base (the local's value). `reinterpret_cast<T*>(sp.ptr)`
  // then retypes this address; `sp.ptr` used as a value reads the same local.
  if (expr.kind === "member_access" && expr.member === "ptr" &&
    expr.object.kind === "identifier" && ctx.scratchpadLocals?.has(expr.object.name)) {
    return { addr: `(local.get $${expr.object.name})`, type: { kind: "pointer", pointee: { kind: "name", name: "uint8" } }, size: 4, layout: null };
  }

  // roots
  if (expr.kind === "identifier") {
    // a reference/pointer local holds the address of its referent; chain member access through it.
    if (ctx.refLocals?.has(expr.name)) {
      const t = ctx.refLocals.get(expr.name)!;
      return { addr: `(local.get $${expr.name})`, type: t, size: ctx.cg.sizeOfType(t, ctx.thisBind ?? NO_BIND), layout: ctx.cg.layoutOfType(t, ctx.thisBind ?? NO_BIND) };
    }
    // an aggregate value-helper / container-method parameter holds the address of its argument; its
    // type may reference template params (KeyT, ValueT), so resolve sizes through the binding. Params
    // shadow the entry-fn input/output/locals names (a helper may name its own params `input`/`output`).
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) {
      const b = ctx.thisBind ?? NO_BIND;
      return { addr: `(local.get $${p.local ?? expr.name})`, type: p.type, size: ctx.cg.sizeOfType(p.type, b), layout: ctx.cg.layoutOfType(p.type, b) };
    }
    if (p) return null;   // a scalar param has no address; don't let it fall through to the entry-fn names
    if (expr.name === "input") return { addr: "(local.get $in)", type: null, size: ctx.in.size, layout: ctx.in };
    if (expr.name === "output") return { addr: "(local.get $out)", type: null, size: ctx.out.size, layout: ctx.out };
    if (expr.name === "locals") return { addr: "(local.get $locals)", type: null, size: ctx.locals.size, layout: ctx.locals };
    // bare `state` (a static helper taking ContractState& — QTF's enableBuyTicket(state, flag)): the
    // resident state region. Only meaningful where the function carries a $state param (entry/private fns).
    if (expr.name === "state" && ctx.hasStateParam && !ctx.localVars.has("state")) {
      return { addr: "(local.get $state)", type: null, size: ctx.state.size, layout: ctx.state };
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

  // ptr + n / ptr - n: pointer arithmetic — the address n elements away, staying pointer-typed
  // (feeds reinterpret_cast<T*>(p + k) in the qpi.h container maintenance bodies).
  if (expr.kind === "binary_op" && (expr.op === "+" || expr.op === "-")) {
    const base = resolveAddr(ctx, expr.left);
    const bt = base?.type;
    if (base && bt?.kind === "pointer") {
      const elemSize = ctx.cg.sizeOfType(bt.pointee, ctx.thisBind) || 8;
      const off = `(i32.mul (i32.wrap_i64 ${emitValue(ctx, expr.right)}) (i32.const ${elemSize}))`;
      const addr = `(${expr.op === "+" ? "i32.add" : "i32.sub"} ${base.addr} ${off})`;
      return { addr, type: bt, size: base.size, layout: null };
    }
  }

  if (expr.kind === "paren") return resolveAddr(ctx, expr.expr);

  // inside a compiled container method: `this` (the object) and `*this` both address the instance.
  if (expr.kind === "this" && ctx.thisLayout) {
    return { addr: ctx.thisAddr ?? "(local.get $this)", type: ctx.thisType ?? null, size: ctx.thisLayout.size, layout: ctx.thisLayout };
  }
  // A pointer/reference cast reinterprets the same address as the target type (the base subobject of a
  // single-inheritance derived object is at offset 0): `static_cast<const ProposalDataType*>(&derived)`,
  // `(ProposalDataType*)this`, `reinterpret_cast<T&>(x)`. Casts parse either as a dedicated node or as a
  // `template_call` to static_cast/reinterpret_cast/const_cast; castInfo normalizes both.
  {
    const ci = castInfo(expr);
    if (ci) {
      const inner = resolveAddr(ctx, ci.operand);
      if (!inner) return null;
      const b = ctx.thisBind ?? NO_BIND;
      const t = stripPtrRefConst(ci.type);
      return { addr: inner.addr, type: t, size: ctx.cg.sizeOfType(t, b), layout: ctx.cg.layoutOfType(t, b) };
    }
  }

  // &lvalue (address-of) and *this (deref) are identity at the addressing level — the node already
  // carries the operand's address.
  if (expr.kind === "unary_op" && expr.op === "&") return resolveAddr(ctx, expr.arg);
  if (expr.kind === "unary_op" && expr.op === "*") {
    if (expr.arg.kind === "this") return resolveAddr(ctx, expr.arg);
    // *cast<T*>(&X): the deref of a pointer cast is the cast operand's address, retyped to the pointee.
    const ci = castInfo(expr.arg);
    if (ci && ci.type.kind === "pointer") {
      const inner = resolveAddr(ctx, ci.operand);
      if (inner) {
        const b = ctx.thisBind ?? NO_BIND;
        const t = stripPtrRefConst(ci.type);
        return { addr: inner.addr, type: t, size: ctx.cg.sizeOfType(t, b), layout: ctx.cg.layoutOfType(t, b) };
      }
    }
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
    // Inside a compiled struct/template method `state` is a ContractState& PARAM (NextEpochData::apply); the
    // wasm local of the same name is the passed address, and the layout comes from the contract's StateData
    // (the ctx there carries an empty state layout).
    const layout = ctx.state.size > 0 ? ctx.state : ctx.cg.contractStateLayout;
    return { addr: "(local.get $state)", type: null, size: layout.size, layout };
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
    let parent = resolveAddr(ctx, expr.object);
    // Member of an id-producing qpi call (`qpi.K12(x).u64._0`): resolveAddr has no lvalue for the call, but
    // emitAddr materializes an id out-producer into a 32-byte slot — chain the limb views off that.
    if (!parent && expr.object.kind === "call" && expr.object.callee.kind === "member_access"
      && expr.object.callee.object.kind === "identifier" && expr.object.callee.object.name === "qpi"
      && (QPI_CALLS[expr.object.callee.member]?.ret === "out" || QPI_ID_PRODUCERS[expr.object.callee.member])) {
      const addr = emitAddr(ctx, expr.object);
      if (addr) parent = { addr, type: { kind: "name", name: "id" }, size: 32, layout: null };
    }
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
    // A member type written in terms of the parent instance's own params / nested typedefs (e.g.
    // ProposalVoting's `proposals` element ProposalAndVotesDataType) is resolved to a concrete type so the
    // member can itself be dispatched as a container / instance. The parent may be spelled through a
    // typedef (NotifyX_input = OracleNotificationInput<OI::Price>) — follow it to the instance first.
    let ptype: TypeSpec | null = parent.type;
    for (let i = 0; i < 8 && ptype?.kind === "name"; i++) ptype = ctx.cg.typedefs.get(ptype.name) ?? null;
    let ftype = ptype?.kind === "template_instance" ? ctx.cg.concreteMemberType(f.type, ptype) : f.type;
    ftype = resolveInParentStruct(ctx, ftype, parent);
    return {
      addr: addrOf(parent.addr, f.offset),
      type: ftype,
      size: f.size,
      layout: ctx.cg.layoutOfType(ftype),
    };
  }

  return null;
}

// Resolve a field type spelled in its declaring struct's own scope — Array<Order,256> where Order is a
// sibling nested struct of the callee-typed parent (QX::AssetAskOrders_output). The parent's layout was
// computed WITH that scope, so sizes already match; this carries the element declaration inline so a
// downstream element getter (orders.get(i).price) can lay it out without the scope.
function resolveInParentStruct(ctx: FnCtx, t: TypeSpec, parent: AddrNode): TypeSpec {
  const decl = parent.type?.kind === "inline_struct"
    ? parent.type.struct
    : parent.type?.kind === "name" ? ctx.cg.structByName(parent.type.name, ctx.thisBind ?? NO_BIND) : undefined;
  if (!decl) return t;

  const nestedOf = (n: string): TypeSpec | null => {
    const s = decl.members.find((m) => m.kind === "struct" && (m as StructDecl).name === n) as StructDecl | undefined;
    return s ? { kind: "inline_struct", struct: s } : null;
  };

  if (t.kind === "name") {
    return nestedOf(t.name) ?? t;
  }
  if (t.kind === "template_instance") {
    let changed = false;
    const args = t.args.map((a) => {
      if (a.kind === "name") {
        const r = nestedOf(a.name);
        if (r) {
          changed = true;
          return r;
        }
      }
      return a;
    });
    return changed ? { ...t, args } : t;
  }
  return t;
}

// Scalar lvalue (size <= 8) address+size, for load/store of a scalar field.
function tryLvalueAddr(ctx: FnCtx, expr: Expression): Lvalue | null {
  const n = resolveAddr(ctx, expr);
  if (!n) return null;
  return { addr: n.addr, size: n.size, type: n.type };
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

  // a uint128-valued expression (constructor / arithmetic / div) materializes into a 16-byte slot
  if ((expr.kind === "call" || expr.kind === "binary_op") && isU128Expr(ctx, expr)) {
    return emitU128(ctx, expr);
  }

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot
  // aggregate ternary (`cond ? roomA : roomB`) selects between the two branch addresses; both branches
  // materialize eagerly (same policy as the value-context ternary), fine for the lvalue selects it serves.
  if (expr.kind === "ternary") {
    const ta = resolveAddr(ctx, expr.then)?.addr ?? emitAddr(ctx, expr.then);
    const ea = ta ? (resolveAddr(ctx, expr.else_)?.addr ?? emitAddr(ctx, expr.else_)) : null;
    if (ta && ea) {
      const t = newTmp(ctx);
      ctx.lines.push(`    ${setLocal(ctx, t, ir.selectV(addrIr(ta), addrIr(ea), ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.cond))))}`);
      return `(local.get $${t})`;
    }
  }

  // min/max over id/m256i operands select an address by the 256-bit lexicographic compare (mirroring the
  // contract-defined `const T&`-returning template helpers); scalar min/max stays in emitMathCall.
  if (expr.kind === "call" && expr.args.length === 2 &&
    (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name")) {
    const cname = expr.callee.kind === "identifier" ? expr.callee.name : expr.callee.name;
    const base = cname.includes("::") ? cname.slice(cname.lastIndexOf("::") + 2) : cname;
    if (base === "min" || base === "max") {
      const la = aggOperand(ctx, expr.args[0]);
      const ra = la ? aggOperand(ctx, expr.args[1]) : null;
      if (la && ra && la.size === 32 && ra.size === 32) {
        const t = newTmp(ctx);
        const cmp = ir.call("$m256_lt", addrIr(la.addr), addrIr(ra.addr));
        const pick = base === "min"
          ? ir.selectV(addrIr(la.addr), addrIr(ra.addr), cmp)
          : ir.selectV(addrIr(ra.addr), addrIr(la.addr), cmp);
        ctx.lines.push(`    ${setLocal(ctx, t, pick)}`);
        return `(local.get $${t})`;
      }
    }
  }

  // aggregate construction Type{...} as an rvalue/argument — materialize into a scratch slot.
  if (expr.kind === "construct") {
    const sz = ctx.cg.sizeOfType(expr.type, ctx.thisBind ?? NO_BIND);
    if (sz > 0) {
      const s = allocSlot(ctx, sz);
      if (emitConstruct(ctx, s, expr.type, expr.args)) return s;
    }
  }

  // id(a,b,c,d) / m256i(a,b,c,d) constructor → materialize the four 64-bit limbs (missing ones = 0).
  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "id" || expr.callee.name === "m256i")) {
    return materializeId(ctx, expr.args);
  }

  // _mm256_set_epi64x(e3, e2, e1, e0): build a 32-byte m256i. The intrinsic takes the qwords high→low (e0 is
  // the lowest), so store reversed — byte offset i*8 holds args[3-i]. (qpi.h's ID(...) returns one of these.)
  if (expr.kind === "call" && expr.callee.kind === "identifier" && expr.callee.name === "_mm256_set_epi64x" && expr.args.length === 4) {
    const s = allocSlotIr(ctx, 32);
    for (let i = 0; i < 4; i++) {
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", i * 8, s, emitValueIr(ctx, expr.args[3 - i])))}`);
    }
    return ir.emit(s);
  }
  // id::zero() / m256i::zero() → 32 zero bytes (X::y parses as one qualified identifier "X::y")
  if (expr.kind === "call" && expr.callee.kind === "identifier" &&
    (expr.callee.name === "id::zero" || expr.callee.name === "m256i::zero")) {
    return materializeId(ctx, []);
  }

  // AssetOwnershipSelect / AssetPossessionSelect constructors → materialize the 40-byte selector the engine
  // reads (id @0, managingContract u16 @32, anyId u8 @34, anyManagingContract u8 @35). byOwner/byPossessor
  // set the id + anyMgmt; any() sets both any flags; byManagingContract sets the index + anyId.
  if (expr.kind === "call" && expr.callee.kind === "identifier" && /^(AssetOwnershipSelect|AssetPossessionSelect)::/.test(expr.callee.name)) {
    const method = expr.callee.name.split("::")[1];
    const s = allocSlotIr(ctx, 40);
    ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(40), ir.i32c(0)))}`);
    if (method === "byOwner" || method === "byPossessor") {
      const src = expr.args[0] ? emitAddr(ctx, expr.args[0]) : null;
      if (src) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(src), ir.i32c(32)))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 35), ir.i32c(1)))}`);
    } else if (method === "any") {
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 34), ir.i32c(1)))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 35), ir.i32c(1)))}`);
    } else if (method === "byManagingContract") {
      const mc = ir.op("i32.and", ir.op("i32.wrap_i64", expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0)), ir.i32c("0xffff"));
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store16", null, ir.addr0(s, 32), mc))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 34), ir.i32c(1)))}`);
    }
    return ir.emit(s);
  }

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot.
  // Runs AFTER the dedicated factory lowerings above — a generic instantiation of e.g.
  // AssetOwnershipSelect::byOwner (reachable since lookupHelper resolves qualified statics) must not
  // shadow the hand-tuned selector shape the engine reads.
  if (expr.kind === "call" && expr.callee.kind === "identifier") {
    const hinfo = lookupHelper(ctx, expr);
    if (hinfo?.retAgg) return emitAggHelperCall(ctx, expr, hinfo);
  }

  // AssetOwnership/PossessionIterator.possessor()/owner() → address of the id in the current buffer record.
  if (expr.kind === "call" && expr.callee.kind === "member_access") {
    const ai = emitAssetIter(ctx, expr, "addr");
    if (ai !== null) return ai;
  }

  // qpi(X).method(...) returning an id/struct (proposerId): compile the real proxy method and
  // materialize the result into its $ret slot — the slot address is the lvalue.
  if (expr.kind === "call" && qpiWrapperMethod(expr)) {
    const pa = emitProposalProxyAddr(ctx, expr);
    if (pa !== null) return pa;
  }

  // qpi.X(...) that returns an id/aggregate by value (computor(i), arbitrator(), nextId(x), prevId(x)):
  // allocate a 32-byte slot, let emitQpiCall emit the host fill (with its args) into it, return the slot.
  // Without this an id-valued qpi getter used as an operand (qpi.computor(i) == voterId) never materializes.
  if (expr.kind === "call" && expr.callee.kind === "member_access" &&
    expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const desc = QPI_CALLS[expr.callee.member];
    if (desc && desc.ret === "out") {
      const s = allocSlot(ctx, 32);
      const q = emitQpiCall(ctx, expr, s);
      if (q) ctx.lines.push(`    ${q.wat}`);
      return s;
    }
    // qpi.invocator() / qpi.originator(): arg-less id producers not in QPI_CALLS.
    const fwd = QPI_ID_PRODUCERS[expr.callee.member];
    if (fwd) {
      const s = allocSlotIr(ctx, 32);
      ctx.lines.push(`    ${ir.emit(ir.call(fwd, s))}`);
      return ir.emit(s);
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
  ctx.lines.push(`    ${setLocal(ctx, self, addrIr(objNode.addr))}`);
  const bind = ctx.thisBind ?? NO_BIND;

  const params = new Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>();
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    const cls = classifyMethodParam(ctx.cg, p, bind);
    const slot = `marg${ctx.tmpCount++}`;
    ctx.localVars.set(slot, { wasmType: cls.wasmType });
    const arg = args[i];
    if (arg) {
      const v = cls.isAddr
        ? addrIr(argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(p.type), bind)))
        : emitValueIr(ctx, arg);
      ctx.lines.push(`    ${setLocal(ctx, slot, v)}`);
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
  // Hoist the inlined body's own local declarations into the host function's local set — the top-level
  // collectLocals never saw them (the method body is a separate AST pulled in at call time), so without
  // this their `local.set` would reference an undeclared `$name`.
  if (fn.body) collectLocals(fn.body, ctx);
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
  if (!node || !node.type || !expr.args[0]) return null;
  // Follow typedefs / template-param bindings to the concrete container instance (e.g. RevenueDonationT →
  // Array<RevenueDonationEntry, 128>), mirroring emitContainerCall. Without this an element getter on a
  // typedef'd container stays unresolved, so `entry = table.get(i)` can't address the element and the
  // aggregate copy is silently dropped.
  let ct: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && ct?.kind === "name"; i++) ct = ctx.thisBind?.types.get(ct.name) ?? ctx.cg.typedefs.get(ct.name) ?? null;
  if (!ct || ct.kind !== "template_instance") return null;
  const ctype = ct;
  const m = expr.callee.member;
  const C = (n: number) => `(i32.const ${n})`;
  const mk = (addr: string, elemType: TypeSpec): AddrNode => ({
    addr, type: elemType, size: ctx.cg.sizeOfType(elemType), layout: ctx.cg.layoutOfType(elemType),
  });

  if (ctype.name === "Array" && m === "get") {
    const info = ctx.cg.arrayInfo(ctype.args);
    if (!info) return null;
    const addr = `(i32.add ${node.addr} (i32.mul (i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)}) ${C(info.elemSize)}))`;
    return mk(addr, ctype.args[0]);
  }
  if (ctype.name === "HashMap" || ctype.name === "HashSet") {
    // Only the element getters are lvalues here. The member check must come BEFORE evaluating the
    // argument: this resolver runs on speculative probes (isU128Expr → resolveAddr), and eagerly
    // emitting a non-getter's argument (contains(qpi.invocator())) produced spurious fidelity
    // warnings for code the real path lowers correctly.
    if (m !== "key" && !(m === "value" && ctype.name === "HashMap")) return null;
    const info = ctype.name === "HashSet" ? ctx.cg.hashsetInfo(ctype.args) : ctx.cg.hashmapInfo(ctype.args);
    if (!info) return null;
    const elem = `(call $hm_elem ${node.addr} (i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)}) ${C(info.elemSize)})`;
    if (m === "key") return mk(elem, ctype.args[0]);
    if (m === "value" && ctype.name === "HashMap") return mk(`(i32.add ${elem} ${C(info.valOff!)})`, ctype.args[1]);
  }
  // Collection.element(i) → &_elements[i & (L-1)].value: an lvalue of element type T, so element(i).field
  // chains. (A scalar T also flows as a value through emitContainerCall's compiled getter.)
  if (ctype.name === "Collection" && m === "element") {
    const info = ctx.cg.collectionInfo(ctype.args);
    if (!info) return null;
    const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)})`;
    const addr = `(i32.add ${node.addr} (i32.add ${C(info.elementsOff + info.valueOff)} (i32.mul ${idx} ${C(info.stride)})))`;
    return mk(addr, info.elemType);
  }
  // LinkedList.element(i) → &_nodes[i & (L-1)].value — same lvalue chaining as Collection.
  if (ctype.name === "LinkedList" && m === "element") {
    const info = ctx.cg.linkedListInfo(ctype.args);
    if (!info) return null;
    const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)})`;
    const addr = `(i32.add ${node.addr} (i32.add ${C(info.nodesOff + info.valueOff)} (i32.mul ${idx} ${C(info.stride)})))`;
    return mk(addr, info.elemType);
  }
  return null;
}

// qpi.* zero-arg accessors that return a 32-byte id by value, written to an out address.
const QPI_ID_PRODUCERS: Record<string, string> = {
  invocator: "$qpi_invocator",
  originator: "$qpi_originator",
  getPrevSpectrumDigest: "$qpi_prevSpectrumDigest",
  getPrevUniverseDigest: "$qpi_prevUniverseDigest",
  getPrevComputerDigest: "$qpi_prevComputerDigest",
};

// Aggregate construction `Type{ a, b, c }` written into dstAddr: zero the target, then store each arg into
// the corresponding field (declaration order). Scalars store by value, aggregate fields copy by address.
// Returns false if the type has no resolvable layout.
function emitConstruct(ctx: FnCtx, dstAddr: string, type: TypeSpec, args: Expression[]): boolean {
  const layout = ctx.cg.layoutOfType(type, ctx.thisBind ?? NO_BIND);
  if (!layout) return false;
  const fields = [...layout.fields.values()];
  const t = newTmp(ctx);
  ctx.lines.push(`    ${setLocal(ctx, t, addrIr(dstAddr))}`);
  ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(t, "i32"), ir.i32c(layout.size), ir.i32c(0)))}`);
  for (let i = 0; i < args.length && i < fields.length; i++) {
    const f = fields[i];
    const fAddr = ir.addr0(ir.getL(t, "i32"), f.offset);
    if (isAggregate(ctx, f.type, f.size)) {
      const src = emitAddr(ctx, args[i]);
      if (src) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", fAddr, addrIr(src), ir.i32c(f.size)))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.storeScalar(fAddr, f.size, emitValueIr(ctx, args[i])))}`);
    }
  }
  return true;
}

// Materialize a 256-bit id/m256i from up to four 64-bit limb expressions into scratch; returns its addr.
function materializeId(ctx: FnCtx, limbs: Expression[]): string {
  const s = allocSlotIr(ctx, 32);
  for (let i = 0; i < 4; i++) {
    const v = limbs[i] ? emitValueIr(ctx, limbs[i]) : ir.i64c(0);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, ir.addr0(s, i * 8), v))}`);
  }
  return ir.emit(s);
}

// True if a type is an aggregate (id/m256i/struct/array) that lives in memory rather than an i64.
function isAggregate(ctx: FnCtx, type: TypeSpec | null, size: number): boolean {
  if (!type) return size > 8;
  if (type.kind === "name" && (type.name === "id" || type.name === "m256i")) return true;
  if (type.kind === "array" || type.kind === "inline_struct" || type.kind === "template_instance") return true;
  if (type.kind === "name" && ctx.cg.layoutOfType(type)) return true;
  return size > 8;
}

// Typed local.set line: the value's width is checked against the local's declared wasm type, so an
// i64 flowing into an i32 address temp (or vice versa) throws at the emission site.
function setLocal(ctx: FnCtx, name: string, v: ir.Ir): string {
  const lv = ctx.localVars.get(name) ?? ctx.params?.get(name);
  if (lv) {
    ir.assertTy(v, lv.wasmType, `local.set $${name}`);
  }
  return ir.emit(ir.setL(name, v));
}

// Allocate a fresh scratch block, stash its address in a new temp, return its `(local.get $tmp)` node.
function allocSlotIr(ctx: FnCtx, size: number): ir.Ir {
  const t = newTmp(ctx);
  ctx.lines.push(`    ${ir.emit(ir.setL(t, ir.call("$qpiAllocLocals", ir.i32c(size))))}`);
  return ir.getL(t, "i32");
}

function allocSlot(ctx: FnCtx, size: number): string {
  return ir.emit(allocSlotIr(ctx, size));
}

// Address of an argument: an lvalue/SELF directly, else materialize the scalar value into scratch.
function argAddr(ctx: FnCtx, expr: Expression, size: number): string {
  const a = emitAddr(ctx, expr);
  if (a) return a;
  const s = allocSlot(ctx, size);
  ctx.lines.push(`    ${storeAt(s, size, emitValue(ctx, expr))}`);
  return s;
}

function addrOf(ptr: string, offset: number): string {
  return ir.emit(ir.addr0(ir.raw(ptr, "i32"), offset));
}

// Load a scalar into the i64 value model. Signed sub-64-bit fields MUST sign-extend — else a sint32 holding
// -1 reads back as 4294967295, and `>= 0` guards (e.g. the proposal-index iteration `while ((i = next()) >=
// 0)`) never go false → infinite loop. Default unsigned (the common case + back-compat).
function loadAt(addr: string, size: number, signed = false): string {
  return ir.emit(loadAtIr(addr, size, signed));
}

// Same load, as a typed node — for value-channel callers holding a string address (resolveAddr/Lvalue
// stay string-typed until the statement channel converts).
function loadAtIr(addr: string, size: number, signed = false): ir.Ir {
  return ir.loadScalar(addrIr(addr), size, signed);
}

// Wrap a string-typed address (the resolveAddr/emitAddr channel) as a typed i32 node.
function addrIr(a: string): ir.Ir {
  return ir.raw(a, "i32", "lvalue address channel");
}

const SIGNED_SCALARS = new Set([
  "sint8", "sint16", "sint32", "sint64",
  "signed char", "signed short", "signed int", "signed long long", "long long", "int", "short", "char",
]);
function isSignedScalarType(t: TypeSpec | null | undefined): boolean {
  if (!t) return false;
  if (t.kind === "const") return isSignedScalarType(t.valueType);
  if (t.kind === "name") return SIGNED_SCALARS.has(t.name);
  return false;
}

function storeAt(addr: string, size: number, value: string): string {
  return ir.emit(ir.storeScalar(ir.raw(addr, "i32"), size, ir.raw(value, "i64")));
}

// Narrow a 64-bit register value to a sub-64-bit scalar type, matching a C++ conversion: unsigned types mask
// to width, signed types sign-extend from width, bit/bool collapse to 0/1. 64-bit and non-scalar targets are
// identity. A store to a typed field already truncates on write (storeAt); this covers in-register uses of a
// cast result — a compare or arithmetic on `static_cast<uint8>(x)` before any store — that must observe the
// narrowed value, e.g. `static_cast<uint8>(300) == 44` is true natively.
function narrowCastIr(inner: ir.Ir, typeName: string | undefined): ir.Ir {
  if (!typeName) return inner;
  const sz = SCALAR_SIZE[typeName];
  if (sz === undefined || sz >= 8) return inner;

  if (typeName === "bit" || typeName === "bool") {
    return ir.op("i64.extend_i32_u", ir.op("i64.ne", ir.i64c(0), inner));
  }
  if (typeName.startsWith("sint") || typeName.startsWith("signed")) {
    const op = sz === 4 ? "i64.extend32_s" : sz === 2 ? "i64.extend16_s" : "i64.extend8_s";
    return ir.op(op, inner);
  }
  const mask = sz === 4 ? "0xffffffff" : sz === 2 ? "0xffff" : "0xff";
  return ir.op("i64.and", inner, ir.i64c(mask));
}

function narrowCast(inner: string, typeName: string | undefined): string {
  return ir.emit(narrowCastIr(ir.raw(inner, "i64"), typeName));
}

// ---- assignment ----

// Lowers an assignment by pushing WAT lines to ctx; returns "" (the statement is fully emitted).
function emitAssign(ctx: FnCtx, expr: Expression & { kind: "assign" }): string {
  const lhs = resolveAddr(ctx, expr.left);

  // uint128 plain assignment: materialize the RHS through the $u128_* machinery (a computed RHS — ternary,
  // (uint128)a * (uint128)b, div<uint128> — has no address, so the aggregate copy below can't handle it).
  if (lhs && expr.op === "=" && isUint128(ctx.cg, lhs.type)) {
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(lhs.addr), emitU128Ir(ctx, expr.right), ir.i32c(16)))}`);
    return "";
  }

  // aggregate target (id/m256i/struct/array): copy by value, or let a qpi producer write into it
  if (lhs && expr.op === "=" && isAggregate(ctx, lhs.type, lhs.size)) {
    // Assignment-form iterator construction (`locals.aoi = AssetOwnershipIterator(asset)`): the RHS
    // `Type(...)` parses as a plain call, so it has no address — lower it like the declaration form, as a
    // begin() on the target (which resets count/cursor and runs the enumerate when an asset is given).
    if (lhs.type?.kind === "name" && /Asset(Ownership|Possession)Iterator$/.test(lhs.type.name)
      && (expr.right.kind === "call" || expr.right.kind === "construct")
      && ((expr.right.kind === "call" && expr.right.callee.kind === "identifier" && /Asset(Ownership|Possession)Iterator$/.test(expr.right.callee.name))
        || expr.right.kind === "construct")) {
      const arg = expr.right.args[0];
      if (arg) {
        emitAssetIter(ctx, {
          kind: "call", span: expr.span, args: [arg],
          callee: { kind: "member_access", span: expr.span, object: expr.left, member: "begin" },
        } as Expression & { kind: "call" }, "stmt");
      } else {
        ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, addrIr(lhs.addr), ir.i64c(0)))}`); // zero count+cursor
      }
      return "";
    }
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
    // bare brace-init-list `target = { a, b, c };` — same field-wise materialization, typed by the target.
    if (expr.right.kind === "initializer_list" && lhs.type && emitConstruct(ctx, lhs.addr, lhs.type, expr.right.exprs)) {
      return "";
    }
    const src = emitAddr(ctx, expr.right);
    if (src) {
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(lhs.addr), addrIr(src), ir.i32c(lhs.size)))}`);
      return "";
    }
    ctx.cg.warn(`unsupported aggregate assignment [${describeShape(expr.left)} = ${describeShape(expr.right)}]`, expr.span.line);
    return "";
  }

  // uint128 compound assignment (z >>= n, prod -= y + z): lhs = lhs <op> rhs via the $u128_* helpers, then
  // copy the 16-byte result back over lhs.
  if (lhs && expr.op !== "=" && isUint128(ctx.cg, lhs.type)) {
    const binOp = expr.op.slice(0, -1);
    const src = emitU128Ir(ctx, { kind: "binary_op", op: binOp, left: expr.left, right: expr.right, span: expr.span } as Expression & { kind: "binary_op" });
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(lhs.addr), src, ir.i32c(16)))}`);
    return "";
  }

  // scalar field target
  if (lhs) {
    if (expr.op === "=") {
      ctx.lines.push(`    ${ir.emit(ir.storeScalar(addrIr(lhs.addr), lhs.size, emitValueIr(ctx, expr.right)))}`);
      return "";
    }

    // Compound assignment lowers as lhs = lhs <op> rhs so the binary op carries the operands'
    // real types (signedness, width, 32-bit wrap) through the usual-conversion machinery.
    ctx.lines.push(`    ${ir.emit(ir.storeScalar(addrIr(lhs.addr), lhs.size, emitValueIr(ctx, compoundToBinary(expr))))}`);
    return "";
  }

  // local variable / scalar value-parameter target (both are mutable wasm locals)
  if (expr.left.kind === "identifier" && isScalarLocal(ctx, expr.left.name)) {
    const n = expr.left.name;
    const rhs = expr.op === "=" ? emitValueIr(ctx, expr.right) : emitValueIr(ctx, compoundToBinary(expr));
    ctx.lines.push(`    ${setLocal(ctx, n, narrowLocalIr(ctx, n, rhs))}`);
    return "";
  }

  ctx.cg.warn(`unsupported assignment target [${describeShape(expr.left)}]`, expr.span.line);
  return "";
}

// Rewrite `lhs <op>= rhs` into the equivalent `lhs <op> rhs` expression node.
function compoundToBinary(expr: Expression & { kind: "assign" }): Expression {
  return { kind: "binary_op", op: expr.op.slice(0, -1), left: expr.left, right: expr.right, span: expr.span } as Expression;
}

// Keep sub-64-bit scalar locals in canonical i64 form (zero-/sign-extended) on every store, so
// loads and compares can consume them without re-extending.
function narrowLocalIr(ctx: FnCtx, name: string, v: ir.Ir): ir.Ir {
  const t = ctx.localVars.get(name)?.type;
  if (t?.kind === "name" && (SCALAR_SIZE[t.name] ?? 8) < 8) {
    return narrowCastIr(v, t.name);
  }
  return v;
}

// ---- value (rvalue) codegen — produces an i64 ----

function emitValueIr(ctx: FnCtx, expr: Expression): ir.Ir {
  // A uint128-valued expression used in a scalar/boolean context (a `while(z)` / `if(z)` truthiness test):
  // materialize it and collapse to (low | high), which is non-zero iff the 128-bit value is non-zero. Scalar
  // reads of a uint128 go through its `.low` / `.high` members, not here.
  if ((expr.kind === "call" || expr.kind === "binary_op" || expr.kind === "identifier" || expr.kind === "member_access") && isU128Expr(ctx, expr)) {
    const a = emitU128Ir(ctx, expr);
    return ir.op("i64.or", ir.loadRaw("i64.load", null, a), ir.loadRaw("i64.load", 8, a));
  }

  // `.low` / `.high` of a uint128-valued expression that is not itself an lvalue (e.g. `div(a, b).low`):
  // materialize the value into a slot, then read the 64-bit half. (A uint128 lvalue's .low/.high resolve
  // through resolveAddr's member path.)
  if (expr.kind === "member_access" && (expr.member === "low" || expr.member === "high") && isU128Expr(ctx, expr.object)) {
    const a = emitU128Ir(ctx, expr.object);
    return ir.loadRaw("i64.load", expr.member === "high" ? 8 : 0, a);
  }

  switch (expr.kind) {
    case "int_literal": {
      const v = ctx.cg["sema"].evaluateConstexpr(expr) ?? 0n;
      return ir.i64c(v);
    }
    case "bool_literal":
      return ir.i64c(expr.value ? 1 : 0);
    case "char_literal":
      return ir.i64c(expr.value);
    case "paren":
      return emitValueIr(ctx, expr.expr);
    case "identifier": {
      // a reference local is an address, not a scalar value — its scalar use is always via a member
      // (handled by resolveAddr below); a bare aggregate read is unsupported.
      if (ctx.localVars.has(expr.name) && !ctx.refLocals?.has(expr.name)) {
        return ir.getL(expr.name, ctx.localVars.get(expr.name)!.wasmType);
      }
      // a pointer local read as a value (p == NULL): the held address, zero-extended.
      if (ctx.refLocals?.get(expr.name)?.kind === "pointer") {
        return ir.op("i64.extend_i32_u", ir.getL(expr.name, "i32"));
      }
      const p = ctx.params?.get(expr.name);
      if (p && !p.isAddr) return ir.getL(p.local ?? expr.name, p.wasmType);
      // A pointer param read as a value (if (ptr), ptr == NULL) is the held address; a scalar
      // reference param reads through it. (Aggregate addr params are read via member access /
      // resolveAddr, not as a bare scalar.)
      if (p && p.isAddr && p.type.kind === "pointer")
        return ir.op("i64.extend_i32_u", ir.getL(p.local ?? expr.name, "i32"));
      if (p && p.isAddr && !ctx.cg.isAggregateType(p.type))
        return ir.loadScalar(ir.getL(p.local ?? expr.name, "i32"), ctx.cg.sizeOfType(p.type), !unsignedScalar(p.type));
      if (expr.name === "SELF_INDEX") return ir.op("i64.extend_i32_u", ir.call("$qpi_contractIndex"));
      if (expr.name === "NULL") return ir.i64c(0);
      // inside a compiled container method: a template non-type param (L), a static constexpr member
      // (_nEncodedFlags), or a bare scalar member of *this (_population).
      if (ctx.thisBind?.values.has(expr.name)) return ir.i64c(ctx.thisBind.values.get(expr.name)!);
      if (ctx.staticConsts?.has(expr.name)) return ir.i64c(ctx.staticConsts.get(expr.name)!);
      if (ctx.thisLayout) {
        const tn = resolveAddr(ctx, expr);
        if (tn && tn.size <= 8) return loadAtIr(tn.addr, tn.size, isSignedScalarType(tn.type));
      }
      // entry-fn `input`/`output` typed by a scalar typedef (typedef uint16 SetShareholderProposal_output):
      // the io name is a region address, so a bare read loads its scalar through it.
      if ((expr.name === "input" || expr.name === "output") && !ctx.localVars.has(expr.name)) {
        const io = resolveAddr(ctx, expr);
        if (io && io.size > 0 && io.size <= 8 && (!io.layout || io.layout.fields.size === 0)) {
          return loadAtIr(io.addr, io.size, isSignedScalarType(io.type));
        }
      }
      // a named constant: enum constant or constexpr (incl. qualified Type::NAME)
      const c = ctx.cg.resolveConst(expr.name);
      if (c !== null) return ir.i64c(c);
      const e = ctx.cg["sema"].evaluateConstexpr(expr);
      if (e !== null) return ir.i64c(e);
      ctx.cg.warn(`unknown identifier '${expr.name}'`, expr.span.line);
      return ir.i64c(0);
    }
    case "member_access": {
      const n = resolveAddr(ctx, expr);
      if (n && n.size <= 8) return loadAtIr(n.addr, n.size, isSignedScalarType(n.type));
      if (n) {
        ctx.cg.warn(`aggregate value read unsupported [${describeShape(expr)}]`, expr.span.line);
        return ir.i64c(0);
      }
      // a static constexpr member of the object's type (pv.maxProposals / pv.maxVotes on ProposalVoting<P,D>):
      // not a runtime field, so resolveAddr can't find it — evaluate it as a constant in the object's scope.
      const obj = resolveAddr(ctx, expr.object);
      let ot: TypeSpec | null = obj?.type ?? null;
      for (let i = 0; i < 8 && ot?.kind === "name"; i++) ot = ctx.cg.typedefs.get(ot.name) ?? null;
      if (ot?.kind === "template_instance") {
        const sc = ctx.cg.staticConstsOf(ot.name, ctx.cg.bindContainer(ot.name, ot.args));
        if (sc.has(expr.member)) return ir.i64c(sc.get(expr.member)!);
      }
      // the same static constexpr read through an inline-typed object (data.variableScalar carries its
      // union/struct decl inline): fold the member's initializer directly.
      if (ot?.kind === "inline_struct") {
        const sm = ot.struct.members.find(
          (m) => m.kind === "variable" && (m as VariableDecl).name === expr.member
            && ((m as VariableDecl).isStatic || (m as VariableDecl).isConstexpr) && (m as VariableDecl).init,
        ) as VariableDecl | undefined;
        if (sm?.init) {
          try {
            return ir.i64c(ctx.cg.evalConstBig(sm.init, ctx.thisBind ?? NO_BIND));
          } catch {
            /* not foldable under these bindings — fall through to the warning */
          }
        }
      }
      // qpi.invocationReward() etc. handled in call; bare member returns 0
      ctx.cg.warn(`unsupported member read [${describeShape(expr)}]`, expr.span.line);
      return ir.i64c(0);
    }
    case "subscript": {
      const n = resolveAddr(ctx, expr);
      if (n && n.size <= 8) return loadAtIr(n.addr, n.size, isSignedScalarType(n.type));
      ctx.cg.warn(`unsupported subscript value`, (expr as any).span?.line ?? 0);
      return ir.i64c(0);
    }
    case "call":
      return emitCallValueIr(ctx, expr);
    case "template_call": {
      if (expr.callee.kind === "identifier") {
        const name = expr.callee.name;
        // C++ cast spelled as a template call. static_cast narrows to its target width; reinterpret_cast/
        // const_cast keep the bits (identity in the scalar i64 model).
        if ((name === "static_cast" || name === "reinterpret_cast" || name === "const_cast") && expr.args[0]) {
          const inner = emitValueIr(ctx, expr.args[0]);
          const tgt = expr.templateArgs?.[0];
          return name === "static_cast" && tgt?.kind === "name" ? narrowCastIr(inner, tgt.name) : inner;
        }
        const m = emitMathCallIr(ctx, name, expr.args);
        if (m !== null) return m;
      }
      if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi"
        && (expr.callee.member === "__qpiQueryOracle" || expr.callee.member === "__qpiSubscribeOracle")) {
        const o = emitOracleQueryCall(ctx, expr);
        if (o !== null) return ir.raw(o, "i64", "unconverted: oracle call");
      }
      ctx.cg.warn(`unsupported template_call '${expr.callee.kind === "identifier" ? expr.callee.name : "?"}' as value`, expr.span.line);
      return ir.i64c(0);
    }
    case "binary_op":
      return emitBinaryIr(ctx, expr);
    case "unary_op": {
      // *ptr as a value: load the pointee through the pointer's held address.
      if (expr.op === "*") {
        const n = resolveAddr(ctx, expr);
        if (n && n.size <= 8) {
          return loadAtIr(n.addr, n.size, isSignedScalarType(n.type));
        }
      }
      const a = emitValueIr(ctx, expr.arg);
      // A 32-bit unsigned result wraps at 32 bits (defined behavior), so - and ~ mask back down to
      // keep the canonical zero-extended form; signed results are already canonical (sign-extended).
      const info = scalarTypeInfo(ctx, expr);
      const mask32 = info !== null && info.width === 4 && info.unsigned;
      switch (expr.op) {
        case "-": {
          const neg = ir.op("i64.sub", ir.i64c(0), a);
          return mask32 ? ir.op("i64.and", neg, ir.i64c("0xffffffff")) : neg;
        }
        case "~": {
          const not = ir.op("i64.xor", a, ir.i64c(-1));
          return mask32 ? ir.op("i64.and", not, ir.i64c("0xffffffff")) : not;
        }
        case "!": return ir.op("i64.extend_i32_u", ir.op("i64.eqz", a));
        default: return a;
      }
    }
    case "prefix_op": {
      // ++x / --x as a value: apply in place (as a side-effect line), then yield the new value.
      const w = emitIncDec(ctx, expr);
      if (w) ctx.lines.push(`    ${w}`);
      return emitValueIr(ctx, expr.arg);
    }
    case "postfix_op": {
      // x++ / x-- as a value: capture the old value, then apply — the expression evaluates to the old.
      const t = `tmp${ctx.tmpCount++}`;
      ctx.localVars.set(t, { wasmType: "i64" });
      ctx.lines.push(`    ${ir.emit(ir.setL(t, emitValueIr(ctx, expr.arg)))}`);
      const w = emitIncDec(ctx, expr);
      if (w) ctx.lines.push(`    ${w}`);
      return ir.getL(t, "i64");
    }
    case "ternary": {
      // C++ evaluates the condition, then exactly ONE arm. wasm select is eager, so it is only safe
      // when both arms are pure and trap-free; otherwise lower as an if/else writing a temp — an arm
      // like `b != 0 ? a / b : 0` must never execute the division on the guarded path.
      const cond = emitValueIr(ctx, expr.cond);
      const saved = ctx.lines;
      ctx.lines = [];
      const thenV = emitValueIr(ctx, expr.then);
      const thenLines = ctx.lines;
      ctx.lines = [];
      const elseV = emitValueIr(ctx, expr.else_);
      const elseLines = ctx.lines;
      ctx.lines = saved;
      if (thenLines.length === 0 && elseLines.length === 0 && ir.pureIr(thenV) && ir.pureIr(elseV)) {
        return ir.selectV(thenV, elseV, ir.op("i64.ne", ir.i64c(0), cond));
      }
      const t = `tmp${ctx.tmpCount++}`;
      ctx.localVars.set(t, { wasmType: "i64" });
      const thenB = [...thenLines, `      ${setLocal(ctx, t, thenV)}`].join("\n");
      const elseB = [...elseLines, `      ${setLocal(ctx, t, elseV)}`].join("\n");
      ctx.lines.push(`    (if (i64.ne (i64.const 0) ${ir.emit(cond)}) (then\n${thenB}\n    ) (else\n${elseB}\n    ))`);
      return ir.getL(t, "i64");
    }
    case "c_cast":
    case "static_cast":
      return narrowCastIr(emitValueIr(ctx, expr.expr), expr.type?.kind === "name" ? expr.type.name : undefined);
    case "sizeof_type":
      return ir.i64c(ctx.cg.sizeOfType(expr.type, ctx.thisBind ?? NO_BIND));
    case "sizeof_expr": {
      // sizeof someLvalue — e.g. sizeof(*this) (the container).
      const n = resolveAddr(ctx, expr.expr);
      if (n) return ir.i64c(n.size);
      // sizeof(TypeName) parses here when the operand is a bare type (e.g. sizeof(Element)) rather than
      // a value — size it as a type, resolving template params (Element) through the binding.
      if (expr.expr.kind === "identifier") {
        const sz = ctx.cg.sizeOfType({ kind: "name", name: expr.expr.name }, ctx.thisBind ?? NO_BIND);
        if (sz > 0) return ir.i64c(sz);
      }
      ctx.cg.warn(`unsupported sizeof expr`, expr.span.line);
      return ir.i64c(0);
    }
    case "assign": {
      // assignment used as a value — `while ((i = next()) >= 0)`, `a = b = 0`. Perform the store (emitAssign
      // pushes it), then yield the stored value by re-reading the target. The RHS is evaluated once (inside
      // emitAssign); the re-read has no side effects.
      emitAssign(ctx, expr);
      return emitValueIr(ctx, expr.left);
    }
    default:
      ctx.cg.warn(`unsupported expression '${expr.kind}' as value`, (expr as any).span?.line ?? 0);
      return ir.i64c(0);
  }
}

function emitValue(ctx: FnCtx, expr: Expression): string {
  return ir.emit(emitValueIr(ctx, expr));
}

// Address+size of an operand that is an aggregate (id/m256i/struct): a struct-field lvalue, or a
// materialized id producer (SELF / id(...) / qpi.invocator()). Null for scalars.
function aggOperand(ctx: FnCtx, expr: Expression): { addr: string; size: number } | null {
  const n = resolveAddr(ctx, expr);
  if (n) return n.size > 8 ? { addr: n.addr, size: n.size } : null;
  const a = emitAddr(ctx, expr);
  return a ? { addr: a, size: 32 } : null;
}

// Whether an expression is uint128-typed (so it flows as a 16-byte value through the $u128_* helpers rather
// than as an i64). A uint128(...) constructor, a div() of uint128 operands, an arithmetic node with a uint128
// operand, or any lvalue of uint128 type.
function isU128Expr(ctx: FnCtx, expr: Expression): boolean {
  if (expr.kind === "paren") return isU128Expr(ctx, expr.expr);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") {
    const t = (expr as any).type;
    if (t?.kind === "name" && (t.name === "uint128" || t.name === "uint128_t")) return true;
    return isU128Expr(ctx, expr.expr);
  }
  if (expr.kind === "ternary") return isU128Expr(ctx, expr.then) || isU128Expr(ctx, expr.else_);
  if (expr.kind === "template_call" && expr.callee.kind === "identifier") {
    const nm = (expr.callee as any).name;
    if ((nm === "div" || nm === "QPI::div" || nm === "mod" || nm === "QPI::mod") && expr.args.length === 2) {
      const ta = expr.templateArgs?.[0];
      if (ta?.kind === "name" && (ta.name === "uint128" || ta.name === "uint128_t")) return true;
      return isU128Expr(ctx, expr.args[0]) || isU128Expr(ctx, expr.args[1]);
    }
  }
  if (expr.kind === "call" && expr.callee.kind === "identifier") {
    const nm = expr.callee.name;
    if (nm === "uint128" || nm === "uint128_t") return true;
    if ((nm === "div" || nm === "QPI::div" || nm === "mod") && expr.args.length === 2) {
      return isU128Expr(ctx, expr.args[0]) || isU128Expr(ctx, expr.args[1]);
    }
  }
  if (expr.kind === "binary_op") {
    if (expr.op === "<<" || expr.op === ">>") return isU128Expr(ctx, expr.left);
    if (expr.op === "*" || expr.op === "+" || expr.op === "-" || expr.op === "&" || expr.op === "|" || expr.op === "^")
      return isU128Expr(ctx, expr.left) || isU128Expr(ctx, expr.right);
    return false;
  }

  // Method calls: answer from the DECLARED return type. Falling through to resolveAddr would
  // speculatively inline the method body (tryInlineStructMethod) — emitted code and fidelity
  // warnings as a side effect of a pure type query.
  if (expr.kind === "call" && expr.callee.kind === "member_access") {
    const obj = resolveAddr(ctx, expr.callee.object);
    let ot: TypeSpec | null = obj?.type ?? null;
    for (let i = 0; i < 8 && ot?.kind === "name"; i++) {
      const next = ctx.thisBind?.types.get(ot.name) ?? ctx.cg.typedefs.get(ot.name);
      if (!next) break;
      ot = next;
    }

    if (ot?.kind === "template_instance") {
      const mt = ctx.cg.methodTemplate(ot.name, ot.args, expr.callee.member, expr.args.length);
      if (mt?.def.returnType) {
        return isUint128(ctx.cg, ctx.cg.substInBindings(ctx.cg.derefType(mt.def.returnType), mt.bind));
      }
    }
    const struct = ot ? ctx.cg.structOf(ot, ctx.thisBind ?? NO_BIND) : null;
    const fn = struct?.members.find(
      (m) => m.kind === "function" && (m as FunctionDecl).name === (expr.callee as Expression & { kind: "member_access" }).member,
    ) as FunctionDecl | undefined;
    if (fn?.returnType) {
      return isUint128(ctx.cg, fn.returnType);
    }
  }

  const n = resolveAddr(ctx, expr);
  return !!(n && isUint128(ctx.cg, n.type));
}

// Materialize a uint128 expression into a fresh 16-byte slot (low@0, high@8) and return its address; an
// existing uint128 lvalue is returned in place. Arithmetic lowers to the $u128_* framework helpers.
function emitU128Ir(ctx: FnCtx, expr: Expression): ir.Ir {
  if (expr.kind === "paren") return emitU128Ir(ctx, expr.expr);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") return emitU128Ir(ctx, expr.expr);

  const n = resolveAddr(ctx, expr);
  if (n && isUint128(ctx.cg, n.type)) return ir.raw(n.addr, "i32", "lvalue address channel");

  const slot = (): ir.Ir => allocSlotIr(ctx, 16);

  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "uint128" || expr.callee.name === "uint128_t")) {
    const s = slot();
    if (expr.args.length === 2) {
      ctx.lines.push(`    ${ir.emit(ir.call("$u128_set", s, emitValueIr(ctx, expr.args[1]), emitValueIr(ctx, expr.args[0])))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.call("$u128_set", s, expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0), ir.i64c(0)))}`);
    }
    return s;
  }

  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "div" || expr.callee.name === "QPI::div") && expr.args.length === 2) {
    const s = slot();
    ctx.lines.push(`    ${ir.emit(ir.call("$u128_divmod", s, emitU128Ir(ctx, expr.args[0]), emitU128Ir(ctx, expr.args[1])))}`);
    return s;
  }

  // div<uint128>(a, b) spelled with an explicit template argument
  if (expr.kind === "template_call" && expr.callee.kind === "identifier" &&
    /^(QPI::)?div$/.test((expr.callee as any).name) && expr.args.length === 2) {
    const s = slot();
    ctx.lines.push(`    ${ir.emit(ir.call("$u128_divmod", s, emitU128Ir(ctx, expr.args[0]), emitU128Ir(ctx, expr.args[1])))}`);
    return s;
  }

  // uint128 ternary: one 16-byte slot, each arm copies its materialized value in.
  if (expr.kind === "ternary") {
    const s = slot();
    ctx.lines.push(`    (if ${ir.emit(ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.cond)))} (then`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, emitU128Ir(ctx, expr.then), ir.i32c(16)))}`);
    ctx.lines.push(`    ) (else`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, emitU128Ir(ctx, expr.else_), ir.i32c(16)))}`);
    ctx.lines.push(`    ))`);
    return s;
  }

  if (expr.kind === "binary_op") {
    const s = slot();
    if (expr.op === "<<" || expr.op === ">>") {
      ctx.lines.push(`    ${ir.emit(ir.call(expr.op === "<<" ? "$u128_shl" : "$u128_shr", s, emitU128Ir(ctx, expr.left), emitValueIr(ctx, expr.right)))}`);
      return s;
    }
    const fn = expr.op === "*" ? "$u128_mul" : expr.op === "+" ? "$u128_add" : expr.op === "-" ? "$u128_sub"
      : expr.op === "&" ? "$u128_and" : expr.op === "|" ? "$u128_or" : expr.op === "^" ? "$u128_xor" : null;
    if (fn) {
      ctx.lines.push(`    ${ir.emit(ir.call(fn, s, emitU128Ir(ctx, expr.left), emitU128Ir(ctx, expr.right)))}`);
      return s;
    }
  }

  // An i64-valued sub-expression used where a uint128 is expected (a bare integer, a scalar local): zero-extend
  // it into the low limb.
  const s = slot();
  ctx.lines.push(`    ${ir.emit(ir.call("$u128_set", s, emitValueIr(ctx, expr), ir.i64c(0)))}`);
  return s;
}

function emitU128(ctx: FnCtx, expr: Expression): string {
  return ir.emit(emitU128Ir(ctx, expr));
}

// True for `auto` (or `auto*`) type specs, which take their real type from the initializer.
function isAutoType(t: TypeSpec): boolean {
  if (t.kind === "pointer") {
    return isAutoType(t.pointee);
  }
  return t.kind === "name" && t.name === "auto";
}

// Resolve a named type through typedef/using aliases to its underlying spec (bounded walk; stops
// at a known scalar name or a non-name spec).
function resolveAliasType(cg: Codegen, t: TypeSpec): TypeSpec {
  let r = t;
  for (let i = 0; i < 8 && r.kind === "name" && SCALAR_SIZE[r.name] === undefined; i++) {
    const td = cg.typedefs.get(r.name);
    if (!td || td.kind === "void") {
      break;
    }
    r = td;
  }
  return r;
}

// True if a scalar type is unsigned (uint*/unsigned/size_t-like). Drives signed-vs-unsigned op selection.
function unsignedScalar(t: TypeSpec | null | undefined): boolean {
  if (!t) return false;
  if (t.kind === "const") return unsignedScalar(t.valueType);
  if (t.kind === "reference") return unsignedScalar(t.refereed);
  if (t.kind === "pointer") return false;
  if (t.kind !== "name") return false;
  return /^(uint|unsigned\b|size_t$|bool$|bit$)/.test(t.name) || t.name === "uint128" || t.name === "uint128_t";
}

// Best-effort signedness of an integer expression: unsigned if it's an unsigned-typed lvalue/param, an unsigned
// cast, an unsigned-suffixed literal, or arithmetic with an unsigned operand (C++ usual-conversion rule). Used
// to pick i64.lt_u/div_u over the signed forms — without this, `uint64 price < (uint64)MAX_AMOUNT` compiled to
// a signed compare and a wrapped-negative qu value read as < MAX_AMOUNT, slipping past range checks.
function isUnsignedExpr(ctx: FnCtx, expr: Expression): boolean {
  switch (expr.kind) {
    case "c_cast": case "static_cast": return unsignedScalar(expr.type);
    case "paren": return isUnsignedExpr(ctx, expr.expr);
    case "int_literal": return /[uU]/.test(expr.suffix ?? "");
    case "identifier": {
      const p = ctx.params?.get(expr.name);
      if (p) return unsignedScalar(p.type);
      const rl = ctx.refLocals?.get(expr.name);
      if (rl) return unsignedScalar(rl);
      const lv = ctx.localVars.get(expr.name)?.type;
      if (lv) return unsignedScalar(lv);
      return unsignedScalar(resolveAddr(ctx, expr)?.type ?? null);
    }
    case "member_access": case "subscript": {
      const t = resolveAddr(ctx, expr)?.type ?? null;
      if (t?.kind === "name" && t.name === "DateAndTime") return true; // compares via its packed uint64 value
      return unsignedScalar(t);
    }
    case "call":
      // qpi out-producers read as scalars are packed uint64 values (qpi.now() → DateAndTime.value)
      return expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier"
        && expr.callee.object.name === "qpi" && QPI_CALLS[expr.callee.member]?.ret === "out";
    case "binary_op":
      if (["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"].includes(expr.op))
        return isUnsignedExpr(ctx, expr.left) || isUnsignedExpr(ctx, expr.right);
      return false;
    case "unary_op":
      if (expr.op === "-" || expr.op === "~" || expr.op === "+")
        return isUnsignedExpr(ctx, expr.arg);
      return false;
    default: return false;
  }
}

// Best-effort (byte width, signedness) of a scalar expression, mirroring isUnsignedExpr's coverage.
// Null when the type can't be derived — callers fall back to the legacy either-unsigned heuristic.
function scalarTypeInfo(ctx: FnCtx, expr: Expression): { width: number; unsigned: boolean } | null {
  switch (expr.kind) {
    case "paren": return scalarTypeInfo(ctx, expr.expr);
    case "c_cast": case "static_cast": {
      const n = expr.type?.kind === "name" ? expr.type.name : null;
      const sz = n ? SCALAR_SIZE[n] : undefined;
      return sz ? { width: sz, unsigned: unsignedScalar(expr.type) } : null;
    }
    case "int_literal": {
      // C++ literal typing: int → (uint for hex/octal) → long long by fit; a u/U suffix forces unsigned.
      const v = ctx.cg["sema"].evaluateConstexpr(expr) ?? 0n;
      const suffixU = /[uU]/.test(expr.suffix ?? "");
      const hex = /^0[xX0-7]/.test(expr.value ?? "");
      if (v >= -(2n ** 31n) && v < 2n ** 31n) return { width: 4, unsigned: suffixU };
      if (hex && v < 2n ** 32n) return { width: 4, unsigned: true };
      if (!suffixU && v < 2n ** 63n) return { width: 8, unsigned: false };
      return { width: 8, unsigned: true };
    }
    case "identifier": case "member_access": case "subscript": {
      const t = expr.kind === "identifier"
        ? (ctx.params?.get(expr.name)?.type ?? ctx.refLocals?.get(expr.name) ?? ctx.localVars.get(expr.name)?.type ?? resolveAddr(ctx, expr)?.type ?? null)
        : (resolveAddr(ctx, expr)?.type ?? null);
      let c = t;
      if (c?.kind === "const") c = c.valueType;
      if (c?.kind === "reference") c = c.refereed;
      const sz = c?.kind === "name" ? SCALAR_SIZE[c.name] : undefined;
      return sz ? { width: sz, unsigned: unsignedScalar(t) } : null;
    }
    case "binary_op": {
      if (["+", "-", "*", "/", "%", "&", "|", "^"].includes(expr.op)) {
        const cv = usualConversion(ctx, expr.left, expr.right);
        return { width: cv.width, unsigned: cv.unsigned };
      }
      if (expr.op === "<<" || expr.op === ">>") return promoteInfo(ctx, expr.left);
      return null;
    }
    case "unary_op": {
      if (expr.op === "-" || expr.op === "~" || expr.op === "+") return promoteInfo(ctx, expr.arg);
      if (expr.op === "!") return { width: 4, unsigned: false };
      return null;
    }
    default: return null;
  }
}

// Integral promotion: sub-int scalars become int (signed, 4 bytes); unknown types fall back to the
// legacy 64-bit + isUnsignedExpr guess so behavior is unchanged where the width can't be derived.
function promoteInfo(ctx: FnCtx, expr: Expression): { width: number; unsigned: boolean } {
  const info = scalarTypeInfo(ctx, expr) ?? { width: 8, unsigned: isUnsignedExpr(ctx, expr) };
  if (info.width < 4) return { width: 4, unsigned: false };
  return info;
}

// C++ usual arithmetic conversions over the promoted operands: same signedness → wider wins; mixed →
// unsigned wins at equal-or-greater rank, else the signed type (which then represents every value of
// the narrower unsigned type).
function usualConversion(ctx: FnCtx, left: Expression, right: Expression): { width: number; unsigned: boolean } {
  const l = promoteInfo(ctx, left);
  const r = promoteInfo(ctx, right);
  const width = Math.max(l.width, r.width);
  if (l.unsigned === r.unsigned) return { width, unsigned: l.unsigned };
  const u = l.unsigned ? l : r;
  const s = l.unsigned ? r : l;
  return u.width >= s.width ? { width, unsigned: true } : { width, unsigned: false };
}

function emitBinaryIr(ctx: FnCtx, expr: Expression & { kind: "binary_op" }): ir.Ir {
  // uint128 compares: 128-bit, via the $u128_* helpers (operands materialized to 16-byte slots).
  if ((expr.op === "==" || expr.op === "!=" || expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=")
    && (isU128Expr(ctx, expr.left) || isU128Expr(ctx, expr.right))) {
    const la = emitU128Ir(ctx, expr.left), ra = emitU128Ir(ctx, expr.right);
    const lt = (x: ir.Ir, y: ir.Ir) => ir.call("$u128_lt", x, y);
    const wrap = (e: ir.Ir) => ir.op("i64.extend_i32_u", e);
    switch (expr.op) {
      case "==": return wrap(ir.call("$u128_eq", la, ra));
      case "!=": return wrap(ir.op("i32.eqz", ir.call("$u128_eq", la, ra)));
      case "<": return wrap(lt(la, ra));
      case ">": return wrap(lt(ra, la));
      case "<=": return wrap(ir.op("i32.eqz", lt(ra, la)));
      default: return wrap(ir.op("i32.eqz", lt(la, ra))); // >=
    }
  }

  // id/struct equality compares bytes, not an i64 value.
  if (expr.op === "==" || expr.op === "!=") {
    const la = aggOperand(ctx, expr.left);
    const ra = aggOperand(ctx, expr.right);
    if (la && ra) {
      const eq = ir.call("$memeq", ir.raw(la.addr, "i32", "lvalue address channel"), ir.raw(ra.addr, "i32", "lvalue address channel"), ir.i32c(Math.min(la.size, ra.size)));
      return expr.op === "==" ? ir.op("i64.extend_i32_u", eq) : ir.op("i64.extend_i32_u", ir.op("i32.eqz", eq));
    }
  }

  // id/m256i ordering (operator< / > / <= / >=): a 256-bit lexicographic compare of the 4 u64 limbs, not an
  // i64 value compare. Mirror m256.h's free operator<; derive the others from it (a>b = b<a, a<=b = !(b<a)).
  if (expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") {
    const la = aggOperand(ctx, expr.left);
    const ra = aggOperand(ctx, expr.right);
    if (la && ra && la.size === 32 && ra.size === 32) {
      const lt = (x: { addr: string }, y: { addr: string }) =>
        ir.call("$m256_lt", ir.raw(x.addr, "i32", "lvalue address channel"), ir.raw(y.addr, "i32", "lvalue address channel"));
      if (expr.op === "<") return ir.op("i64.extend_i32_u", lt(la, ra));
      if (expr.op === ">") return ir.op("i64.extend_i32_u", lt(ra, la));
      if (expr.op === "<=") return ir.op("i64.extend_i32_u", ir.op("i32.eqz", lt(ra, la)));
      return ir.op("i64.extend_i32_u", ir.op("i32.eqz", lt(la, ra)));
    }
  }

  // Short-circuit `&&` / `||`: the right operand must not be evaluated when the left already decides the
  // result — C++ guards like `idx >= max || array[idx]` rely on this to stay in bounds. The right side is
  // emitted into an isolated line buffer; if it produced statements, those run only on the not-decided path.
  if (expr.op === "&&" || expr.op === "||") {
    const lb = ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.left));
    const saved = ctx.lines;
    ctx.lines = [];
    const rExpr = emitValueIr(ctx, expr.right);
    const rLines = ctx.lines;
    ctx.lines = saved;
    const rb = ir.op("i64.ne", ir.i64c(0), rExpr);
    if (rLines.length === 0) {
      return expr.op === "||"
        ? ir.raw(`(i64.extend_i32_u (if (result i32) ${ir.emit(lb)} (then (i32.const 1)) (else ${ir.emit(rb)})))`, "i64", "inline if-expression")
        : ir.raw(`(i64.extend_i32_u (if (result i32) ${ir.emit(lb)} (then ${ir.emit(rb)}) (else (i32.const 0))))`, "i64", "inline if-expression");
    }
    const tmp = newTmp(ctx);
    const rBranch = [...rLines, `      (local.set $${tmp} ${ir.emit(rb)})`].join("\n");
    if (expr.op === "||") {
      ctx.lines.push(`    (if ${ir.emit(lb)} (then (local.set $${tmp} (i32.const 1))) (else\n${rBranch}\n    ))`);
    } else {
      ctx.lines.push(`    (if ${ir.emit(lb)} (then\n${rBranch}\n    ) (else (local.set $${tmp} (i32.const 0))))`);
    }
    return ir.op("i64.extend_i32_u", ir.getL(tmp, "i32"));
  }

  const l = emitValueIr(ctx, expr.left);
  const r = emitValueIr(ctx, expr.right);
  // C++ usual arithmetic conversions decide the operation's signedness and rank. A 32-bit unsigned
  // result wraps at 32 bits natively (defined behavior), so +,-,*,<< mask back down; signed 32-bit
  // overflow is UB and stays unmasked. Shifts take their type from the LEFT operand alone.
  const cv = usualConversion(ctx, expr.left, expr.right);
  const u = cv.unsigned;
  const li = promoteInfo(ctx, expr.left);
  const wrapL = (n: ir.Ir, active: boolean) => (active ? ir.op("i64.and", n, ir.i64c("0xffffffff")) : n);
  const wrap32 = u && cv.width === 4;

  // A signed 32-bit operand converted to unsigned 32-bit changes representation (sign-extended →
  // zero-extended), so value-sensitive ops (/, %, compares) mask it to the canonical unsigned form.
  const toU32 = (n: ir.Ir, e: Expression) => {
    if (!wrap32) {
      return n;
    }
    const pi = promoteInfo(ctx, e);
    return pi.width === 4 && !pi.unsigned ? ir.op("i64.and", n, ir.i64c("0xffffffff")) : n;
  };
  const lc = toU32(l, expr.left);
  const rc = toU32(r, expr.right);
  const cmp = (op: string) => ir.op("i64.extend_i32_u", ir.op(op, lc, rc));

  switch (expr.op) {
    case "+": return wrapL(ir.op("i64.add", l, r), wrap32);
    case "-": return wrapL(ir.op("i64.sub", l, r), wrap32);
    case "*": return wrapL(ir.op("i64.mul", l, r), wrap32);
    case "/": return ir.op(u ? "i64.div_u" : "i64.div_s", lc, rc);
    case "%": return ir.op(u ? "i64.rem_u" : "i64.rem_s", lc, rc);
    case "<<": return wrapL(ir.op("i64.shl", l, r), li.unsigned && li.width === 4);
    // Signed right-shift is arithmetic in C++ — zero-filling a negative sint64 silently corrupts it.
    case ">>": return ir.op(li.unsigned ? "i64.shr_u" : "i64.shr_s", l, r);
    case "&": return ir.op("i64.and", l, r);
    case "|": return wrapL(ir.op("i64.or", l, r), wrap32);
    case "^": return wrapL(ir.op("i64.xor", l, r), wrap32);
    case "==": return cmp("i64.eq");
    case "!=": return cmp("i64.ne");
    case "<": return cmp(u ? "i64.lt_u" : "i64.lt_s");
    case ">": return cmp(u ? "i64.gt_u" : "i64.gt_s");
    case "<=": return cmp(u ? "i64.le_u" : "i64.le_s");
    case ">=": return cmp(u ? "i64.ge_u" : "i64.ge_s");
    default: return ir.i64c(0);
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
// "asset" consumes ONE Asset argument (id issuer; uint64 assetName) but emits TWO operands — the assetName
// (i64, loaded from offset 32) then the issuer address — matching the lhost share calls' (name, issuer, …).
type ArgKind = "i64" | "i32" | "addr" | "cidx" | "asset" | "ownsel" | "possel" | "sized" | "assetref";
interface QpiCallDesc {
  fwd: string;
  args: ArgKind[];
  ret: "i64" | "i32" | "void" | "out";
}

const QPI_CALLS: Record<string, QpiCallDesc> = {
  transfer: { fwd: "$qpi_transfer", args: ["addr", "i64"], ret: "i64" },
  K12: { fwd: "$qpi_k12", args: ["sized"], ret: "out" },
  now: { fwd: "$qpi_now", args: [], ret: "out" },
  burn: { fwd: "$qpi_burn", args: ["i64", "cidx"], ret: "i64" },
  issueAsset: { fwd: "$qpi_issueAsset", args: ["i64", "addr", "i32", "i64", "i64"], ret: "i64" },
  isAssetIssued: { fwd: "$qpi_isAssetIssued", args: ["addr", "i64"], ret: "i32" },
  transferShareOwnershipAndPossession: { fwd: "$qpi_transferShares", args: ["i64", "addr", "addr", "addr", "i64", "addr"], ret: "i64" },
  numberOfShares: { fwd: "$qpi_numberOfShares", args: ["assetref", "ownsel", "possel"], ret: "i64" },
  numberOfPossessedShares: { fwd: "$qpi_numberOfPossessedShares", args: ["i64", "addr", "addr", "addr", "i32", "i32"], ret: "i64" },
  releaseShares: { fwd: "$qpi_releaseShares", args: ["asset", "addr", "addr", "i64", "i32", "i32", "i64"], ret: "i64" },
  acquireShares: { fwd: "$qpi_acquireShares", args: ["asset", "addr", "addr", "i64", "i32", "i32", "i64"], ret: "i64" },
  distributeDividends: { fwd: "$qpi_distributeDividends", args: ["i64"], ret: "i32" },
  dayOfWeek: { fwd: "$qpi_dayOfWeek", args: ["i32", "i32", "i32"], ret: "i32" },
  getEntity: { fwd: "$qpi_getEntity", args: ["addr", "addr"], ret: "i32" },
  isContractId: { fwd: "$qpi_isContractId", args: ["addr"], ret: "i32" },
  nextId: { fwd: "$qpi_nextId", args: ["addr"], ret: "out" },
  prevId: { fwd: "$qpi_prevId", args: ["addr"], ret: "out" },
  arbitrator: { fwd: "$qpi_arbitrator", args: [], ret: "out" },
  computor: { fwd: "$qpi_computor", args: ["i32"], ret: "out" },
  queryFeeReserve: { fwd: "$qpi_queryFeeReserve", args: ["i32"], ret: "i64" },
  bidInIPO: { fwd: "$qpi_bidInIPO", args: ["i32", "i64", "i32"], ret: "i64" },
  ipoBidPrice: { fwd: "$qpi_ipoBidPrice", args: ["i32", "i32"], ret: "i64" },
  ipoBidId: { fwd: "$qpi_ipoBidId", args: ["i32", "i32"], ret: "out" },
  unsubscribeOracle: { fwd: "$qpi_unsubscribeOracle", args: ["i32"], ret: "i32" },
  getOracleQueryStatus: { fwd: "$qpi_getOracleQueryStatus", args: ["i64"], ret: "i32" },
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
// Materialize a 40-byte AssetOwnershipSelect / AssetPossessionSelect and return its address (i32). These have
// no inferred type at the call site (brace-init or a static-factory result), so emitAddr can't lower them.
// Layout: id owner/possessor @0 (32), managingContract u16 @32, anyOwner/anyPossessor bool @34,
// anyManagingContract bool @35. Forms handled: a missing argument (the C++ default `::any()`), the static
// factories any()/byOwner()/byPossessor()/byManagingContract(), a `{id, mgmt}` brace-init, and an addressable
// select lvalue. any() = { zero, 0, true, true }; byOwner/byPossessor = { id, 0, false, true };
// byManagingContract = { zero, mgmt, true, false } (see qpi.h AssetOwnershipSelect).
function materializeSelect(ctx: FnCtx, e: Expression | undefined): string {
  const s = allocSlotIr(ctx, 40);
  ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(40), ir.i32c(0)))}`);
  const flag = (off: number, v: number) => ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, off), ir.i32c(v)))}`);
  const clamp = (e2: Expression, mnemonic: string, off: number, mask: string) =>
    ctx.lines.push(`    ${ir.emit(ir.storeRaw(mnemonic, null, ir.addr0(s, off), ir.op("i32.and", ir.op("i32.wrap_i64", emitValueIr(ctx, e2)), ir.i32c(mask))))}`);
  const staticName = e && e.kind === "call"
    ? (e.callee.kind === "qualified_name" ? e.callee.name : e.callee.kind === "member_access" ? e.callee.member : null)
    : null;
  if (!e || staticName === "any") {
    flag(34, 1);
    flag(35, 1);
  } else if (staticName === "byOwner" || staticName === "byPossessor") {
    const idSrc = e.kind === "call" && e.args[0] ? emitAddr(ctx, e.args[0]) : null;
    if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    flag(35, 1);
  } else if (staticName === "byManagingContract") {
    if (e.kind === "call" && e.args[0]) clamp(e.args[0], "i32.store16", 32, "0xffff");
    flag(34, 1);
  } else if (e.kind === "initializer_list") {
    const idSrc = e.exprs[0] ? emitAddr(ctx, e.exprs[0]) : null;
    if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    if (e.exprs[1]) clamp(e.exprs[1], "i32.store16", 32, "0xffff");
    if (e.exprs[2]) clamp(e.exprs[2], "i32.store8", 34, "1");
    if (e.exprs[3]) clamp(e.exprs[3], "i32.store8", 35, "1");
  } else {
    const a = emitAddr(ctx, e);
    if (a) {
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(a), ir.i32c(40)))}`);
    } else {
      flag(34, 1);
      flag(35, 1);
    }
  }
  return ir.emit(s);
}

function emitQpiOperands(ctx: FnCtx, args: Expression[], kinds: ArgKind[]): string[] {
  const ops: string[] = [];
  let ai = 0;
  for (const k of kinds) {
    if (k === "cidx") {
      ops.push("(call $qpi_contractIndex)");
      continue;
    }
    const e = args[ai++];
    if (k === "ownsel" || k === "possel") {
      // Selector is passed by address (i32). A missing arg is the C++ default `::any()`, so this must run
      // before the generic missing-arg fallback below (which would push an i64 0 and break wasm validation).
      ops.push(materializeSelect(ctx, e));
      continue;
    }
    if (k === "assetref") {
      // const Asset& — 40 bytes {id issuer @0, uint64 assetName @32}. Accepts a `{issuer, name}`
      // brace-init (Escrow's numberOfShares calls) or an addressable Asset lvalue.
      if (e?.kind === "initializer_list") {
        const s = allocSlotIr(ctx, 40);
        ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(40), ir.i32c(0)))}`);
        const idSrc = e.exprs[0] ? emitAddr(ctx, e.exprs[0]) : null;
        if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
        if (e.exprs[1]) ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, ir.addr0(s, 32), emitValueIr(ctx, e.exprs[1])))}`);
        ops.push(ir.emit(s));
        continue;
      }
      const a = e ? (resolveAddr(ctx, e)?.addr ?? emitAddr(ctx, e)) : null;
      if (a) {
        ops.push(a);
      } else {
        if (e) ctx.cg.warn(`qpi argument is not an addressable id/struct`, (e as any).span?.line ?? 0);
        ops.push("(i32.const 0)");
      }
      continue;
    }
    if (k === "sized") {
      // data passed as (addr, sizeof(data)) — the host hashes/copies raw bytes (qpi.K12(const T&)).
      if (!e) {
        ops.push("(i32.const 0)", "(i32.const 0)");
        continue;
      }
      const node = resolveAddr(ctx, e);
      const addr = node?.addr ?? emitAddr(ctx, e);
      if (!addr) {
        ctx.cg.warn(`qpi argument is not an addressable value`, (e as any).span?.line ?? 0);
        ops.push("(i32.const 0)", "(i32.const 0)");
        continue;
      }
      const sz = e.kind === "construct"
        ? ctx.cg.sizeOfType(e.type, ctx.thisBind ?? NO_BIND)
        : node?.type ? ctx.cg.sizeOfType(node.type, ctx.thisBind ?? NO_BIND) : 32;
      ops.push(addr, `(i32.const ${sz || 32})`);
      continue;
    }
    if (!e) {
      ops.push(k === "addr" ? "(i32.const 0)" : "(i64.const 0)");
      continue;
    }
    if (k === "asset") {
      const a = emitAddr(ctx, e);
      if (a) {
        const t = newTmp(ctx);
        ctx.lines.push(`    ${setLocal(ctx, t, addrIr(a))}`);
        ops.push(ir.emit(ir.loadRaw("i64.load", null, ir.addr0(ir.getL(t, "i32"), 32))));   // assetName
        ops.push(ir.emit(ir.getL(t, "i32")));                                               // issuer addr
      } else {
        ctx.cg.warn(`qpi argument is not an addressable id/struct`, (e as any).span?.line ?? 0);
        ops.push("(i64.const 0)", "(i32.const 0)");
      }
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
    ops.push(outAddr ?? allocSlot(ctx, 32));
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
function compileContainerMethod(cg: Codegen, type: TypeSpec & { kind: "template_instance" }, methodName: string, argCount?: number): CompiledMethod | null {
  const cacheKey = `${type.name}<${type.args.map((a) => cg.typeKeyOf(a)).join(",")}>::${methodName}/${argCount ?? "?"}`;
  const cached = cg.compiledMethods.get(cacheKey);
  if (cached) return cached;

  // Specialization-aware: the body + its binding come from the matched template instance (primary OR partial
  // specialization), so a specialization's storage layout and its access methods stay in agreement.
  const mt = cg.methodTemplate(type.name, type.args, methodName, argCount);
  if (!mt || !mt.def.body) return null;
  const def = mt.def;
  const bind = mt.bind;
  const fnParams = (def.fnParams ?? []).map((p) => classifyMethodParam(cg, p, bind));
  const retKind: "i64" | "void" = cg.isVoidType(def.returnType) ? "void" : (cg.isAggregateType(cg.derefType(def.returnType)) ? "void" : "i64");

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
  // Register params with their CONCRETE types (ValueT → uint64): a scalar ref-param read sizes and signs
  // its load from the registered type, and the raw template name would default to a 4-byte signed load —
  // silently sign-truncating every HashMap<*, uint64>::set above 2^31.
  for (const p of cm.fnParams) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: cg.substInBindings(cg.derefType(p.type), bind) });

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
  const cm = compileContainerMethod(ctx.cg, type, method, args.length);
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
  if (!node || !node.type) return null;
  // follow typedefs to the concrete container instance (e.g. bit_4096 → BitArray<4096>). Resolve through the
  // active template bindings first so a method parameter typed by a template param (ProposalDataType → D) or a
  // proxy-bound alias dispatches against the concrete instance.
  let ct: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && ct?.kind === "name"; i++) {
    const next: TypeSpec | undefined = ctx.thisBind?.types.get(ct.name) ?? ctx.cg.typedefs.get(ct.name);
    if (!next) break;
    ct = next;
  }
  // A plain (non-template) struct with an inline method (ProposalDataYesNo::checkValidity) is dispatched as
  // a zero-arg instance — normalize its name type to a template_instance so the shared method-compilation
  // path (callCompiled → compileContainerMethod) applies, the same as a template ProposalDataType. A field
  // of nested-struct type carries an inline_struct node (the layout inlines it) — dispatch by its name too.
  if (ct?.kind === "inline_struct" && ct.struct.name && ctx.cg.templateMethods.get(ct.struct.name)?.has(expr.callee.member)) {
    ct = { kind: "template_instance", name: ct.struct.name, args: [] } as TypeSpec;
  }
  if (ct?.kind === "name" && ctx.cg.templateMethods.get(ct.name)?.has(expr.callee.member)) {
    ct = { kind: "template_instance", name: ct.name, args: [] } as TypeSpec;
  }
  if (!ct || ct.kind !== "template_instance") return null;
  // A namespace-qualified spelling (QPI::HashMap<sint64,uint32,16> local) dispatches by its base name —
  // the layout side already strips the qualifier (instantiateTemplate), the name checks here must too.
  if (ct.name.includes("::") && !ctx.cg.templates.has(ct.name)) {
    ct = { ...ct, name: ct.name.slice(ct.name.lastIndexOf("::") + 2) };
  }
  node.type = ct;

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
      const cm = compileContainerMethod(ctx.cg, node.type, "get", 2);
      const call = cm
        ? `(call ${cm.label} ${map} ${k} ${out})`
        : `(i64.extend_i32_u (call $hm_get ${map} ${k} ${out} ${dims} ${C(info.hashMode!)}))`;
      if (valueWanted) return call;
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: container call")))}`);
      return "";
    }

    // set (HashMap) / add (HashSet) both insert; add has no value.
    if (member === "set" || member === "add") {
      if (wireCompiled(member)) return valueWanted ? lastWired : "";
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = isSet ? k : argAddr(ctx, expr.args[1], info.valSize!);
      const call = `(i64.extend_i32_s (call $hm_set ${map} ${k} ${v} ${dims} ${C(info.popOff!)} ${C(info.hashMode!)}))`;
      if (valueWanted) return call;
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: container call")))}`);
      return "";
    }
    if (member === "removeByKey" || member === "remove") {
      if (wireCompiled(member)) return valueWanted ? lastWired : "";
      if (valueWanted) return null;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_remove", addrIr(map), addrIr(k), ir.i32c(info.L!), ir.i32c(info.elemSize), ir.i32c(info.keySize!), ir.i32c(info.occBase!), ir.i32c(info.popOff!), ir.i32c(info.hashMode!)))}`);
      return "";
    }
    if (member === "replace") {
      if (wireCompiled("replace")) return valueWanted ? lastWired : "";
      if (valueWanted) return null;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = argAddr(ctx, expr.args[1], info.valSize!);
      const t = newTmp(ctx);
      ctx.lines.push(`    ${setLocal(ctx, t, ir.raw(indexOf(k), "i32", "unconverted: hm index probe"))}`);
      ctx.lines.push(`    (if (i32.ge_s (local.get $${t}) (i32.const 0)) (then (call $copyMem (i32.add (call $hm_elem ${map} (local.get $${t}) ${C(info.elemSize)}) ${C(info.valOff!)}) ${v} ${C(info.valSize!)})))`);
      return "";
    }
    if (member === "reset" && !valueWanted) {
      if (wireCompiled("reset")) return "";
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_reset", addrIr(map), ir.i32c(info.totalSize!)))}`);
      return "";
    }
    // cleanup family: compaction + threshold checks over the mark-removal counter, matching the
    // native rehash byte-for-byte (slot placement is contract state).
    const threshold = () => (expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(50));
    if (member === "cleanup" && !valueWanted) {
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_cleanup", addrIr(map), ir.i32c(info.L!), ir.i32c(info.elemSize), ir.i32c(info.keySize!), ir.i32c(info.occBase!), ir.i32c(info.popOff!), ir.i32c(info.hashMode!), ir.i32c(info.totalSize!)))}`);
      return "";
    }
    if (member === "cleanupIfNeeded" && !valueWanted) {
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_cleanup_if", addrIr(map), ir.i32c(info.L!), ir.i32c(info.elemSize), ir.i32c(info.keySize!), ir.i32c(info.occBase!), ir.i32c(info.popOff!), ir.i32c(info.hashMode!), ir.i32c(info.totalSize!), threshold()))}`);
      return "";
    }
    if (member === "needsCleanup" && valueWanted) {
      return ir.emit(ir.call("$hm_needs_cleanup", addrIr(map), ir.i32c(info.L!), ir.i32c(info.popOff!), threshold()));
    }
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
        // A brace-init value (`arr.set(i, { owner, amount })`) has no address — materialize it into a slot
        // via emitConstruct. Never fall back to copying from address 0.
        let src = emitAddr(ctx, expr.args[1]);
        if (!src && (expr.args[1].kind === "initializer_list" || expr.args[1].kind === "construct") && info.elemType) {
          const vals = expr.args[1].kind === "initializer_list" ? expr.args[1].exprs : expr.args[1].args;
          const s = allocSlot(ctx, info.elemSize);
          if (emitConstruct(ctx, s, info.elemType, vals)) src = s;
        }
        if (!src) {
          ctx.cg.warn(`unsupported Array.set aggregate value`, expr.span.line);
          return "";
        }
        ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(ea), addrIr(src), ir.i32c(info.elemSize)))}`);
      } else {
        ctx.lines.push(`    ${storeAt(ea, info.elemSize, emitValue(ctx, expr.args[1]))}`);
      }
      return "";
    }
    if (member === "setAll" && !valueWanted && !aggr) {
      // setAll(v): write v to every element. value scalar only (aggregate setAll is rare).
      const v = emitValueIr(ctx, expr.args[0]);
      const i = newTmp(ctx), val = newTmp(ctx);
      ctx.localVars.set(val, { wasmType: "i64" });
      ctx.lines.push(`    ${setLocal(ctx, val, v)}`);
      ctx.lines.push(`    ${setLocal(ctx, i, ir.i32c(0))}`);
      ctx.lines.push(`    (block $sa_done (loop $sa`);
      ctx.lines.push(`      (br_if $sa_done (i32.ge_u (local.get $${i}) ${C(info.L)}))`);
      ctx.lines.push(`      ${storeAt(`(i32.add ${map} (i32.mul (local.get $${i}) ${C(info.elemSize)}))`, info.elemSize, `(local.get $${val})`)}`);
      ctx.lines.push(`      (local.set $${i} (i32.add (local.get $${i}) (i32.const 1)))`);
      ctx.lines.push(`      (br $sa)))`);
      return "";
    }
  }

  // Collection (priority queues over a per-PoV BST) and LinkedList (doubly-linked with a free list):
  // every method is compiled from the real qpi.h body. element(i)/pov(i) return the element value /
  // its pov id — for a scalar element it flows as an i64 value here; an aggregate element (a struct)
  // is an lvalue resolved by resolveContainerElem so element(i).field chains (return null to fall
  // through to that path).
  if (node.type.name === "Collection" || node.type.name === "LinkedList") {
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

  // BitArray<L> (bit_4096 etc.): get/set/setAll/capacity are inline methods compiled from the qpi.h body.
  // Any other captured template instance (ProposalDataV1, ProposalAndVotingByComputors,
  // ProposalWithAllVoteData, ...): dispatch the method through its real qpi.h body.
  if (node.type.name === "BitArray" || ctx.cg.templateMethods.get(node.type.name)?.has(member)) {
    const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
    if (!c) return null;
    if (valueWanted) return c.cm.retKind === "void" ? null : c.call;
    ctx.lines.push(c.cm.retKind === "void" ? `    ${c.call}` : `    (drop ${c.call})`);
    return "";
  }

  return null;
}

// QPI safe-math + helper free functions, lowered to scalar i64. div/mod guard division by zero;
// sadd/smul saturate at the 64-bit type extreme, both matching math_lib.h. (The 32-bit overloads
// clamp at INT32/UINT32 natively — the i64 value model uses the 64-bit clamp for those too.)
function emitMathCallIr(ctx: FnCtx, name: string, args: Expression[]): ir.Ir | null {
  const a = () => (args[0] ? emitValueIr(ctx, args[0]) : ir.i64c(0));
  const b = () => (args[1] ? emitValueIr(ctx, args[1]) : ir.i64c(0));
  // accept a namespace-qualified spelling (math_lib::max, QPI::div, RL::min) — strip the qualifier.
  const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  // div/mod/min/max take the unsigned variant when either operand is unsigned (C++ usual-conversion rule).
  // Without this, `min(div(reward,price), slots)` on a huge uint64 reward picked the wrong branch via a signed
  // compare, so RL's BuyTicket computed a giant `toBuy` and looped ~forever. `sdiv` stays explicitly signed.
  const u = (args[0] ? isUnsignedExpr(ctx, args[0]) : false) || (args[1] ? isUnsignedExpr(ctx, args[1]) : false);
  const s = u ? "u" : "s";
  switch (base) {
    case "sdiv": return ir.call("$m_div_s", a(), b());
    case "div": return ir.call(`$m_div_${s}`, a(), b());
    case "mod": return ir.call(`$m_mod_${s}`, a(), b());
    case "min": return ir.call(`$m_min_${s}`, a(), b());
    case "max": return ir.call(`$m_max_${s}`, a(), b());
    case "abs": return ir.call("$m_abs", a());
    // sadd/smul are SATURATING natively (math_lib.h clamps at the type extreme) — plain wrap-around
    // arithmetic silently diverges exactly at the overflow boundary.
    case "sadd": return ir.call(`$m_sadd_${s}`, a(), b());
    case "smul": return ir.call(`$m_smul_${s}`, a(), b());
    default: return null;
  }
}

function emitMathCall(ctx: FnCtx, name: string, args: Expression[]): string | null {
  const n = emitMathCallIr(ctx, name, args);
  return n === null ? null : ir.emit(n);
}

// Call to a contract value helper (toReturnCode(...)): scalar args by value, aggregate args by
// address. valueWanted → returns the i64 result; otherwise pushes the call as a statement.
// Compile a qpi.h namespace free function (ProposalTypes::cls / optionCount) on first use: register it as a
// pure value helper and emit its wasm function. Returns its HelperInfo, or null if it can't be compiled.
function compileLibFn(cg: Codegen, name: string): HelperInfo | null {
  const cached = cg.helpers.get(name);
  if (cached) return cached;
  // `using namespace QPI` lets a call drop the QPI:: qualifier; libFns are keyed by full namespace path.
  const fn = cg.libFns.get(name) ?? cg.libFns.get(`QPI::${name}`);
  if (!fn || !fn.body) return null;
  const params = fn.params.map((p) => {
    // A NON-const scalar reference (RL::makeDateStamp's `uint32& res`) is an out-param and must travel by
    // address for the write to reach the caller; a const scalar ref stays a value (same policy as helpers).
    const isConstRef = p.type.kind === "reference" && p.type.refereed?.kind === "const";
    const isPtrRef = (p.type.kind === "reference" && !isConstRef) || p.type.kind === "pointer";
    const isAddr = isPtrRef || cg.isAggregateType(p.type);
    const byValAgg = isAddr && p.type.kind !== "reference" && p.type.kind !== "pointer";
    return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: cg.derefType(p.type), byValAgg };
  });
  const retAgg = !cg.isVoidType(fn.returnType) && cg.isAggregateType(fn.returnType) ? cg.sizeOfType(fn.returnType) : undefined;
  const retIsValue = !cg.isVoidType(fn.returnType) && !retAgg;
  const info: HelperInfo = { label: `$lib${cg.helpers.size}_${name.replace(/[^a-zA-Z0-9]/g, "_")}`, params, retIsValue, retAgg };
  cg.helpers.set(name, info);   // register before emit so recursion/sibling calls resolve
  try {
    cg.emittedMethodOrder.push(emitHelperFunction(cg, info, fn, { size: 0, align: 1, fields: new Map() }));
  } catch (e: any) {
    cg.warn(`failed to compile lib fn ${name}: ${e.message}`, fn.span?.line ?? 0);
    cg.helpers.delete(name);
    return null;
  }
  return info;
}

// Deduce template bindings (T→sint64, L→4) for a free function template from the concrete types of its
// call-site arguments: a param `const Array<T,L>&` matched against arg `Array<sint64,4>` binds T and L.
function deduceLibFnBindings(ctx: FnCtx, def: FunctionTemplateDecl, args: Expression[]): Bindings {
  const types = new Map<string, TypeSpec>();
  const values = new Map<string, bigint>();
  const typeParams = new Set(def.params.filter((p) => p.kind === "type").map((p) => p.name));
  const valueParams = new Set(def.params.filter((p) => p.kind !== "type").map((p) => p.name));
  const fps = def.fnParams ?? [];

  const argType = (a: Expression): TypeSpec | null => {
    let t = resolveAddr(ctx, a)?.type ?? null;
    if (!t) return null;
    t = ctx.cg.derefType(t);
    // Resolve through the caller's template bindings so the deduced type is concrete (ProposalDataType →
    // ProposalDataV1<false>), not a symbolic param name the instantiated lib fn can't size.
    if (ctx.thisBind) t = ctx.cg.derefType(ctx.cg.substInBindings(t, ctx.thisBind));
    for (let i = 0; i < 8 && t.kind === "name"; i++) {
      const td = ctx.cg.typedefs.get(t.name);
      if (!td) break;
      t = ctx.cg.derefType(td);
    }
    return t;
  };

  for (let i = 0; i < fps.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    const pt = ctx.cg.derefType(fps[i].type);
    if (pt.kind === "template_instance") {
      const at = argType(arg);
      if (at?.kind !== "template_instance" || at.name !== pt.name) continue;
      for (let j = 0; j < pt.args.length && j < at.args.length; j++) {
        const pa = pt.args[j];
        if (pa.kind !== "name") continue;
        if (typeParams.has(pa.name) && !types.has(pa.name)) types.set(pa.name, at.args[j]);
        else if (valueParams.has(pa.name) && !values.has(pa.name)) values.set(pa.name, ctx.cg.valueOfTypeArg(at.args[j]));
      }
    } else if (pt.kind === "name" && typeParams.has(pt.name) && !types.has(pt.name)) {
      const at = argType(arg);
      if (at) types.set(pt.name, at);
    }
  }
  return { types, values, structs: new Map() };
}

// Pick the overload whose parameter patterns best match the concrete argument types. A concrete name
// in a pattern (ProposalWithAllVoteData<ProposalDataYesNo, maxVotes>) must EQUAL the argument's type
// at that position — matching disqualifies the def otherwise — while a template-param name matches
// anything. Mirrors C++ partial-ordering just far enough for qpi.h's overload sets: the YesNo
// specialization wins for YesNo args and is rejected for V1 args.
function pickLibFnOverload(ctx: FnCtx, defs: FunctionTemplateDecl[], args: Expression[]): FunctionTemplateDecl {
  if (defs.length === 1) return defs[0];

  const argTypeOf = (a: Expression): TypeSpec | null => {
    let t = resolveAddr(ctx, a)?.type ?? null;
    if (!t) return null;
    t = ctx.cg.derefType(t);
    if (ctx.thisBind) t = ctx.cg.derefType(ctx.cg.substInBindings(t, ctx.thisBind));
    return t;
  };
  const argTypes = args.map(argTypeOf);

  const score = (def: FunctionTemplateDecl): number => {
    const fps = def.fnParams ?? [];
    if (args.length > fps.length) return -1;
    const tparams = new Set(def.params.map((p) => p.name));

    let s = 0;
    for (let i = 0; i < fps.length && i < args.length; i++) {
      const pat = ctx.cg.derefType(fps[i].type);
      const at = argTypes[i];
      if (!at) continue;
      if (pat.kind === "name") {
        if (tparams.has(pat.name)) s += 1;
        else if (at.kind === "name" && at.name === pat.name) s += 2;
        continue;
      }
      if (pat.kind === "template_instance" && at.kind === "template_instance") {
        if (pat.name !== at.name) return -1;
        for (let j = 0; j < pat.args.length && j < at.args.length; j++) {
          const pa = pat.args[j];
          if (pa.kind !== "name") continue;
          if (tparams.has(pa.name)) {
            s += 1;
          } else {
            const aa = at.args[j];
            if (aa.kind === "name" && aa.name === pa.name) s += 2;
            else if (aa.kind === "template_instance" && aa.name === pa.name) s += 2;
            else return -1;
          }
        }
      }
    }
    return s;
  };

  let best = defs[0];
  let bestScore = score(defs[0]);
  for (let i = 1; i < defs.length; i++) {
    const s = score(defs[i]);
    if (s > bestScore) {
      best = defs[i];
      bestScore = s;
    }
  }
  return best;
}

// Instantiate a free function template for the concrete types at a call site, emitting its wasm function.
// Param types are substituted through the deduced bindings (Array<T,L> → Array<sint64,4>) so the body's
// container calls resolve, and bare value params (`L`) read from thisBind.values. Cached by instantiation.
function compileLibFnInstance(ctx: FnCtx, def: FunctionTemplateDecl, args: Expression[]): HelperInfo | null {
  const cg = ctx.cg;
  const bind = deduceLibFnBindings(ctx, def, args);
  const keyArgs = def.params
    .map((p) => (p.kind === "type" ? cg.typeKeyOf(bind.types.get(p.name) ?? { kind: "name", name: p.name }) : (bind.values.get(p.name)?.toString() ?? p.name)))
    .join(",");
  // The overload's source line disambiguates same-name defs whose deduced args coincide.
  const key = `${def.name}@${def.span?.line ?? 0}<${keyArgs}>`;
  const cached = cg.helpers.get(key);
  if (cached) return cached;

  const params = (def.fnParams ?? []).map((p) => {
    const isPtrRef = p.type.kind === "reference" || p.type.kind === "pointer";
    const concrete = cg.substInBindings(cg.derefType(p.type), bind);
    const isAddr = isPtrRef || cg.isAggregateType(concrete);
    const byValAgg = isAddr && !isPtrRef;
    return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: concrete, byValAgg };
  });
  const retT = cg.substInBindings(cg.derefType(def.returnType), bind);
  const retAgg = !cg.isVoidType(def.returnType) && cg.isAggregateType(retT) ? cg.sizeOfType(retT, bind) : undefined;
  const retIsValue = !cg.isVoidType(def.returnType) && !retAgg;
  const info: HelperInfo = { label: `$lib${cg.helpers.size}_${key.replace(/[^a-zA-Z0-9]/g, "_")}`, params, retIsValue, retAgg };
  cg.helpers.set(key, info);   // register before emit so recursive/sibling calls resolve
  try {
    cg.emittedMethodOrder.push(emitHelperFunction(cg, info, def, { size: 0, align: 1, fields: new Map() }, bind));
  } catch (e: any) {
    cg.warn(`failed to instantiate lib fn ${key}: ${e.message}`, def.span?.line ?? 0);
    cg.helpers.delete(key);
    return null;
  }
  return info;
}

// QPI safe-math free functions (div/mod/min/max/...) have a dedicated, divide-by-zero-safe lowering in
// emitMathCall. Their qpi.h template bodies (`return b ? (a/b) : 0`) rely on ternary short-circuit we don't
// guarantee, so they must NOT be instantiated as generic lib fns — let emitMathCall own them.
const MATH_INTRINSIC_NAMES = new Set(["div", "sdiv", "mod", "min", "max", "abs", "sadd", "ssub", "smul"]);

// Build the args for a helper call (scalar args by value, reference/aggregate args by address).
function helperCallOps(ctx: FnCtx, info: HelperInfo, args: Expression[]): string {
  return info.params.map((p, i) => {
    const arg = args[i];
    if (!arg) return p.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return p.isAddr ? (emitAddr(ctx, arg) ?? "(i32.const 0)") : emitValue(ctx, arg);
  }).join(" ");
}

// Call to an aggregate-returning helper (id liquidityPov(...)): allocate the destination slot, pass it as the
// leading $ret arg, emit the call as a statement, and return the slot's address (so the result chains like any
// aggregate lvalue).
function emitAggHelperCall(ctx: FnCtx, expr: Expression & { kind: "call" }, info: HelperInfo): string {
  const s = allocSlot(ctx, info.retAgg!);
  const ops = helperCallOps(ctx, info, expr.args);
  ctx.lines.push(`    (call ${info.label} ${s}${ops ? " " + ops : ""})`);
  return s;
}

// Resolve a helper / lib-fn name to its (possibly just-compiled) info, or null.
function lookupHelper(ctx: FnCtx, expr: Expression & { kind: "call" }): HelperInfo | null {
  if (expr.callee.kind !== "identifier") return null;
  // Match the intrinsics by base name — a qualified QPI::div would otherwise slip past this guard,
  // get instantiated from its qpi.h template body, and lose the divide-by-zero-safe lowering.
  const name = expr.callee.name;
  const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  if (MATH_INTRINSIC_NAMES.has(base)) return null;
  let info = ctx.cg.helpers.get(expr.callee.name) ?? compileLibFn(ctx.cg, expr.callee.name);
  if (!info) {
    // A namespace free function template (isArraySortedWithoutDuplicates<T,L>): instantiate for this call,
    // picking the overload whose parameter patterns match the argument types.
    const tdefs = ctx.cg.libFnTemplates.get(expr.callee.name) ?? ctx.cg.libFnTemplates.get(`QPI::${expr.callee.name}`);
    if (tdefs?.length) info = compileLibFnInstance(ctx, pickLibFnOverload(ctx, tdefs, expr.args), expr.args);
  }
  if (!info && name.includes("::")) {
    // Qualified static member call (OI::Price::getQueryFee(q)) — resolve the struct (namespace members
    // are flattened at parse; structByName strips qualifiers), wrap the static method as a template-less
    // lib fn and instantiate it through the same helper cache.
    const segs = name.split("::");
    const method = segs[segs.length - 1];
    const sd = ctx.cg.structByName(segs.slice(0, -1).join("::"), ctx.thisBind ?? NO_BIND);
    const fn = sd?.members.find(
      (m): m is Declaration & { kind: "function" } => m.kind === "function" && m.name === method && m.isStatic && !!m.body,
    );
    if (sd && fn) {
      // Param/return types spelled in the owner's scope (const OracleReply&) name its nested structs —
      // substitute them inline so the instance compiles without the owner's lookup scope.
      const nestedOf = new Map(sd.members.filter((m): m is StructDecl => m.kind === "struct" && !!m.name).map((m) => [m.name, m]));
      const qual = (tp: TypeSpec): TypeSpec => {
        if (tp.kind === "const") return { ...tp, valueType: qual(tp.valueType) };
        if (tp.kind === "reference") return { ...tp, refereed: qual(tp.refereed) };
        if (tp.kind === "name" && nestedOf.has(tp.name)) return { kind: "inline_struct", struct: nestedOf.get(tp.name)!, span: tp.span };
        return tp;
      };
      const def: FunctionTemplateDecl = {
        kind: "function_template", name: `${sd.name}::${method}`, params: [],
        fnParams: fn.params.map((p) => ({ ...p, type: qual(p.type) })),
        returnType: qual(fn.returnType), body: fn.body, isConstexpr: fn.isConstexpr, span: fn.span,
      };
      info = compileLibFnInstance(ctx, def, expr.args);
    }
  }
  return info ?? null;
}

function emitHelperCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  const info = lookupHelper(ctx, expr);
  if (!info) return null;

  // An aggregate-returning helper flows as an address — materialize into a slot. In value context return 0
  // (the aggregate value is reached through emitAddr); as a statement just run it for its side effects.
  if (info.retAgg) {
    const addr = emitAggHelperCall(ctx, expr, info);
    return valueWanted ? "(i64.const 0)" : (void addr, "");
  }

  const ops = helperCallOps(ctx, info, expr.args);
  const call = `(call ${info.label}${ops ? " " + ops : ""})`;

  if (valueWanted) return info.retIsValue ? call : "(i64.const 0)";
  ctx.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
  return "";
}

// Inside a compiled container method: a call to a sibling method of *this (getElementIndex(key)) or the
// hash functor (HashFunc::hash(key)). Returns null when not applicable.
// AssetOwnership/PossessionIterator — the contract only touches it through its methods, so we control its
// representation: iter[0]=record count, iter[4]=cursor. begin() runs the assetEnumerate host import (kind 0
// ownership / 1 possession) into the framework's $assetIterBase buffer (80-byte records: owner@0,
// possessor@32, shares@64); the cursor walks it. Returns the WAT for value/addr modes, pushes lines for stmt.
function emitAssetIter(ctx: FnCtx, expr: Expression & { kind: "call" }, mode: "stmt" | "value" | "addr"): string | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  const tn = node?.type?.kind === "name" ? (node.type as any).name : null;
  if (!node || (tn !== "AssetOwnershipIterator" && tn !== "AssetPossessionIterator")) return null;
  const method = expr.callee.member;
  const it = newTmp(ctx);
  ctx.lines.push(`    ${setLocal(ctx, it, addrIr(node.addr))}`);
  const itN = ir.getL(it, "i32");
  const iter = ir.emit(itN);
  const cursorN = ir.loadRaw("i32.load", null, ir.addr0(itN, 4));
  const count = `(i32.load ${iter})`;
  const cursor = ir.emit(cursorN);
  const rec = `(i32.add (global.get $assetIterBase) (i32.mul ${cursor} (i32.const 80)))`;

  if (method === "begin") {
    const selN = allocSlotIr(ctx, 40);
    ctx.lines.push(`    ${ir.emit(ir.call("$setMem", selN, ir.i32c(40), ir.i32c(0)))}`);   // any-select: anyId + anyMgmt
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(selN, 34), ir.i32c(1)))}`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(selN, 35), ir.i32c(1)))}`);
    const asset = expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const kind = tn === "AssetPossessionIterator" ? 1 : 0;
    const enumerate = ir.call("$lh_assetEnumerate", ir.i32c(kind), addrIr(asset), selN, selN, ir.raw("(global.get $assetIterBase)", "i32"), ir.i32c(1024));
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, itN, enumerate))}`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, ir.addr0(itN, 4), ir.i32c(0)))}`);
    return "";
  }
  if (method === "next") {
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, ir.addr0(itN, 4), ir.op("i32.add", cursorN, ir.i32c(1))))}`);
    return "";
  }
  if (method === "reachedEnd") return `(i64.extend_i32_u (i32.ge_u ${cursor} ${count}))`;
  if (method === "numberOfPossessedShares" || method === "numberOfOwnedShares") return `(i64.load (i32.add ${rec} (i32.const 64)))`;
  if (method === "possessor") return mode === "addr" ? `(i32.add ${rec} (i32.const 32))` : `(i64.load (i32.add ${rec} (i32.const 32)))`;
  if (method === "owner") return mode === "addr" ? rec : `(i64.load ${rec})`;
  if (method === "ownershipManagingContract") return `(i64.extend_i32_u (i32.load16_u (i32.add ${rec} (i32.const 72))))`;
  return null;
}

function emitThisCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (!ctx.thisType || ctx.thisType.kind !== "template_instance" || expr.callee.kind !== "identifier") return null;
  const name = expr.callee.name;

  // Collection cleanup variants stay stubbed (the compaction path needs _tzcnt intrinsics); the
  // store remains a correct, just uncompacted, BST. _rebuild compiles from its real qpi.h body via
  // the sibling-method dispatch below — its balanced result is contract state and feeds the digest.
  if ((name === "cleanup" || name === "cleanupIfNeeded") && !valueWanted) return "";
  if (name === "needsCleanup" && valueWanted) return "(i64.const 0)";

  // memory builtins used by container bodies: reset → setMem(this, ...); removeByIndex → setMem(&elem, ...).
  // Kept out of the contract surface (qpi.h hides them from contracts); valid only as statements here.
  if ((name === "setMem" || name === "copyMem") && !valueWanted) {
    const dst = emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)";
    if (name === "copyMem") {
      const src = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(dst), addrIr(src), ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[2]))))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.call("$setMem", addrIr(dst), ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[1])), ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[2]))))}`);
    }
    return "";
  }

  // HashFunc::hash(key) — for an id/m256i key the hash is its first 8 bytes; otherwise K12(key).
  if (name.endsWith("::hash")) {
    const keyAddr = emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)";
    const keyT = ctx.thisBind?.types.get("KeyT") ?? ctx.thisBind?.types.get("T");
    const keySize = keyT ? ctx.cg.sizeOfType(keyT, ctx.thisBind) : 32;
    if (keySize === 32) return `(i64.load ${keyAddr})`;
    const s = allocSlotIr(ctx, 8);
    ctx.lines.push(`    ${ir.emit(ir.call("$qpi_k12", addrIr(keyAddr), ir.i32c(keySize), s))}`);
    return `(i64.load ${ir.emit(s)})`;
  }

  // a sibling method of this container instance — compile it and call with $this + args. An
  // own-class-qualified static (DateAndTime::isLeapYear(y) inside another DateAndTime method)
  // is the same dispatch with the class prefix stripped; the static body never reads $this.
  const mname = name.startsWith(`${ctx.thisType.name}::`) ? name.slice(ctx.thisType.name.length + 2) : name;
  const cm = compileContainerMethod(ctx.cg, ctx.thisType, mname, expr.args.length);
  if (!cm) return null;
  // A reference-scalar argument that is a plain wasm local (addAndComputeCarry(newMicrosec, carry, ...))
  // has no address: spill it to a slot, pass the slot, and write the slot back after the call so
  // out-parameter writes reach the local.
  const writeBacks: string[] = [];
  const ops = cm.fnParams.map((fp, i) => {
    const arg = expr.args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (!fp.isAddr) return emitValue(ctx, arg);
    const a = emitAddr(ctx, arg);
    if (a) return a;
    // `&x` (pointer out-param) and parens unwrap to the same scalar-local spill as a bare `x`.
    let root = arg;
    while (root.kind === "paren" || (root.kind === "unary_op" && root.op === "&")) {
      root = root.kind === "paren" ? root.expr : root.arg;
    }
    const s = allocSlotIr(ctx, 8);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, s, emitValueIr(ctx, root)))}`);
    if (root.kind === "identifier" && ctx.localVars.get(root.name)?.wasmType === "i64") {
      writeBacks.push(`    ${setLocal(ctx, root.name, ir.loadRaw("i64.load", null, s))}`);
    }
    return ir.emit(s);
  });
  const call = `(call ${cm.label} (local.get $this) ${ops.join(" ")})`;
  if (valueWanted) {
    if (cm.retKind !== "i64") {
      ctx.lines.push(`    ${call}`);
      ctx.lines.push(...writeBacks);
      return "(i64.const 0)";
    }
    if (!writeBacks.length) return call;
    const r = `tmp${ctx.tmpCount++}`;
    ctx.localVars.set(r, { wasmType: "i64" });
    ctx.lines.push(`    ${setLocal(ctx, r, ir.raw(call, "i64", "unconverted: container method call"))}`);
    ctx.lines.push(...writeBacks);
    return `(local.get $${r})`;
  }
  ctx.lines.push(cm.retKind === "i64" ? `    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: container method call")))}` : `    ${call}`);
  ctx.lines.push(...writeBacks);
  return "";
}

// rvalue call: a value helper, qpi getter, qpi valued host call, a value-returning container method,
// or a math helper.
function emitCallValueIr(ctx: FnCtx, expr: Expression & { kind: "call" }): ir.Ir {
  // isZero(id) / id.isZero() — true iff all 32 bytes are zero (OR the four 64-bit limbs, test for zero).
  {
    const idObj = expr.callee.kind === "identifier" && expr.callee.name === "isZero" ? expr.args[0]
      : (expr.callee.kind === "member_access" && expr.callee.member === "isZero") ? expr.callee.object
      : null;
    if (idObj) {
      const addr = emitAddr(ctx, idObj);
      if (addr) {
        const t = newTmp(ctx);
        ctx.lines.push(`    ${setLocal(ctx, t, addrIr(addr))}`);
        const a = ir.getL(t, "i32");
        const limb = (off: number) => ir.loadRaw("i64.load", null, ir.addr0(a, off));
        const ors = ir.op("i64.or", ir.op("i64.or", limb(0), limb(8)), ir.op("i64.or", limb(16), limb(24)));
        return ir.op("i64.extend_i32_u", ir.op("i64.eqz", ors));
      }
    }
  }

  // ProposalVoting proxy `qpi(state.proposals).method(...)` — compile the real qpi.h proxy method against
  // the wrapped ProposalVoting instance. A sibling proxy call inside a proxy body (clearProposal) resolves
  // here too. Falls back to the terminating stub if the instance/method can't be compiled.
  if (ctx.proxyClass) {
    const sib = emitProxySiblingCall(ctx, expr, true);
    if (sib !== null) return ir.raw(sib, "i64", "unconverted: proxy sibling call");
  }
  {
    const m = qpiWrapperMethod(expr);
    if (m) {
      const real = emitProposalProxyCall(ctx, expr, true);
      if (real !== null) return ir.raw(real, "i64", "unconverted: proposal proxy call");
      if (m === "nextProposalIndex" || m === "nextFinishedProposalIndex") return ir.i64c(-1);
      if (m === "setProposal") return ir.i64c(ctx.cg.resolveConst("INVALID_PROPOSAL_INDEX") ?? 65535n);
      return ir.i64c(0);
    }
  }

  // Inter-contract call in value context — the _E forms capture the InterContractCallError into a variable
  // (`InterContractCallError err = __qpi_..._other(...)`). Same lowering as the statement form, but the i32
  // error result flows out instead of being dropped.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "__qpi_call_other" || expr.callee.name === "__qpi_invoke_other")) {
    const wat = emitInterContract(ctx, expr, expr.callee.name === "__qpi_invoke_other");
    if (wat) return ir.op("i64.extend_i32_s", ir.raw(wat, "i32", "unconverted: inter-contract call"));
    ctx.cg.warn(`unsupported inter-contract call to '${expr.args[0]?.kind === "identifier" ? expr.args[0].name : "?"}' (no callee IDL)`, expr.span.line);
    return ir.i64c(0);
  }

  const ai = emitAssetIter(ctx, expr, "value");
  if (ai !== null) return ir.raw(ai, "i64", "unconverted: asset iterator");

  const tc = emitThisCall(ctx, expr, true);
  if (tc !== null) return ir.raw(tc, "i64", "unconverted: this-call");

  const h = emitHelperCall(ctx, expr, true);
  if (h !== null) return ir.raw(h, "i64", "unconverted: helper call");

  if (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name") {
    const nm = expr.callee.kind === "identifier" ? expr.callee.name : `${expr.callee.namespace}::${expr.callee.name}`;
    const m = emitMathCallIr(ctx, nm, expr.args);
    if (m !== null) return m;
  }
  if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const g = QPI_GETTERS[expr.callee.member];
    if (g) return g.ret === "i64" ? ir.call(g.fwd) : ir.op("i64.extend_i32_u", ir.call(g.fwd));
    // qpi out-producer used as a scalar value (`qpi.now() < endDate`): materialize the out struct and read
    // its leading 8 bytes — the scalar-context out producers are 8-byte packed values (DateAndTime.value).
    const desc = QPI_CALLS[expr.callee.member];
    if (desc && desc.ret === "out") {
      const a = emitAddr(ctx, expr);
      if (a) return ir.loadRaw("i64.load", null, ir.raw(a, "i32", "lvalue address channel"));
    }
  }

  const q = emitQpiCall(ctx, expr);
  if (q) {
    if (q.ret === "i64") return ir.raw(q.wat, "i64", "unconverted: qpi call");
    if (q.ret === "i32") return ir.op("i64.extend_i32_u", ir.raw(q.wat, "i32", "unconverted: qpi call"));
  }

  const c = emitContainerCall(ctx, expr, true);
  if (c !== null) return ir.raw(c, "i64", "unconverted: container call");

  // Functional-style scalar cast: uint64(x) / sint64(x) / uint8(x) / bit(x) ... — narrowed to the target
  // width (matching the c_cast/static_cast lowering); a store to a typed field additionally truncates.
  if (expr.callee.kind === "identifier" && SCALAR_SIZE[expr.callee.name] !== undefined && expr.args.length === 1) {
    return narrowCastIr(emitValueIr(ctx, expr.args[0]), expr.callee.name);
  }

  // The same cast through a template parameter: T(x) inside a qpi.h template body where T binds to a
  // scalar type. Aggregate bindings fall through to the construct/materialize paths.
  if (expr.callee.kind === "identifier" && expr.args.length === 1) {
    const bound = ctx.thisBind?.types.get(expr.callee.name);
    if (bound?.kind === "name" && SCALAR_SIZE[bound.name] !== undefined) {
      return narrowCastIr(emitValueIr(ctx, expr.args[0]), bound.name);
    }
  }

  // uint128(i_high, i_low) two-arg constructor as a scalar value: the i64-collapsed model carries the low
  // 64 bits, so the value is the LOW arg (arg[1]). The high arg is dropped — fine for the values this is used
  // on (shift counts and small magnitudes that fit 64 bits, e.g. QSWAP's `uint128(0, 126)` = 126). Without
  // this it fell through to the unsupported-call fallback and became 0 — so `z >>= uint128(0, 2)` shifted by
  // 0 and the integer-sqrt loop never terminated.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "uint128" || expr.callee.name === "uint128_t") && expr.args.length === 2) {
    return emitValueIr(ctx, expr.args[1]);
  }

  ctx.cg.warn(`unsupported call as value [${describeShape(expr)}]`, expr.span.line);
  return ir.i64c(0);
}

function emitCallValue(ctx: FnCtx, expr: Expression & { kind: "call" }): string {
  return ir.emit(emitCallValueIr(ctx, expr));
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
  // Returns the bare i32 call expression (the InterContractCallError). The statement caller drops it; the
  // _E forms capture it into their errorVar (value context).
  if (isInvoke) {
    const reward = expr.args[4] ? emitValue(ctx, expr.args[4]) : "(i64.const 0)";
    return `(call $liteInvokeProcedure ${dims} ${reward})`;
  }
  return `(call $liteCallFunction ${dims})`;
}

// The ProposalVoting wrapper call shape: `qpi(<aggregate>).<method>(...)` — a member call whose object is a
// `qpi(...)` call. Returns the method name, or null if this isn't that shape.
function qpiWrapperMethod(expr: Expression & { kind: "call" }): string | null {
  const c = expr.callee;
  if (c.kind !== "member_access") return null;
  const o = c.object;
  if (o.kind === "call" && o.callee.kind === "identifier" && o.callee.name === "qpi") return c.member;
  return null;
}

const PROXY_PROCEDURE_METHODS = new Set(["setProposal", "clearProposal", "vote"]);

// Resolve `qpi(X)`'s wrapped object X to a concrete ProposalVoting<P,D> instance + its address.
function resolveProxyTarget(ctx: FnCtx, xExpr: Expression): { addr: string; pvType: TypeSpec & { kind: "template_instance" } } | null {
  const node = resolveAddr(ctx, xExpr);
  if (!node || !node.type) return null;
  let pvt: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && pvt?.kind === "name"; i++) pvt = ctx.cg.typedefs.get(pvt.name) ?? null;
  if (!pvt || pvt.kind !== "template_instance" || pvt.name !== "ProposalVoting") return null;
  // resolve the ProposalVoting args (ProposersAndVotersT/ProposalDataT contract typedefs) to concrete types
  const args = pvt.args.map((a) => ctx.cg.resolveType(a, NO_BIND));
  return { addr: node.addr, pvType: { kind: "template_instance", name: "ProposalVoting", args, span: pvt.span } };
}

// Lower `qpi(X).method(args)` to a call of the real qpi.h proxy method compiled against ProposalVoting<P,D>.
function emitProposalProxyCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  const method = qpiWrapperMethod(expr);
  if (!method) return null;
  const xExpr = ((expr.callee as any).object as Expression & { kind: "call" }).args[0];
  if (!xExpr) return null;
  const target = resolveProxyTarget(ctx, xExpr);
  if (!target) return null;

  const proxyClass = PROXY_PROCEDURE_METHODS.has(method) ? "QpiContextProposalProcedureCall" : "QpiContextProposalFunctionCall";
  const cm = compileProxyMethod(ctx.cg, target.pvType, proxyClass, method);
  if (!cm) return null;
  return callProxy(ctx, cm, target.addr, target.pvType, expr.args, valueWanted);
}

// `qpi(X).method(args)` whose method returns an aggregate: emit the call writing into a fresh slot and
// return the slot address (the lvalue emitAddr chains through). Null when not a proxy call or the
// method returns a scalar/void.
function emitProposalProxyAddr(ctx: FnCtx, expr: Expression & { kind: "call" }): string | null {
  const method = qpiWrapperMethod(expr);
  if (!method) return null;
  const xExpr = ((expr.callee as Expression & { kind: "member_access" }).object as Expression & { kind: "call" }).args[0];
  if (!xExpr) return null;
  const target = resolveProxyTarget(ctx, xExpr);
  if (!target) return null;

  const proxyClass = PROXY_PROCEDURE_METHODS.has(method) ? "QpiContextProposalProcedureCall" : "QpiContextProposalFunctionCall";
  const cm = compileProxyMethod(ctx.cg, target.pvType, proxyClass, method);
  if (!cm || !cm.retAgg) return null;

  const bind = ctx.cg.bindContainer(target.pvType.name, target.pvType.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = expr.args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return fp.isAddr ? argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(fp.type), bind)) : emitValue(ctx, arg);
  });
  const s = allocSlot(ctx, cm.retAgg!);
  ctx.lines.push(`    (call ${cm.label} ${s} ${target.addr} (i32.const 0)${ops.length ? " " + ops.join(" ") : ""})`);
  return s;
}

// A bare sibling call inside a proxy body (e.g. clearProposal(idx) from setProposal) — compile it against
// the same ProposalVoting instance, passing the current `$pv`/`$qpi`.
function emitProxySiblingCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (!ctx.proxyClass || expr.callee.kind !== "identifier") return null;
  const method = expr.callee.name;
  const known = ctx.cg.templateMethods.get(ctx.proxyClass)?.has(method) || ctx.cg.templateMethods.get("QpiContextProposalFunctionCall")?.has(method);
  if (!known) return null;
  const pvType = ctx.refLocals?.get("pv");
  if (!pvType || pvType.kind !== "template_instance") return null;
  const cm = compileProxyMethod(ctx.cg, pvType, ctx.proxyClass, method);
  if (!cm) return null;
  return callProxy(ctx, cm, "(local.get $pv)", pvType, expr.args, valueWanted);
}

// Emit the actual `(call $PV…)`: self = the ProposalVoting address, then the dummy qpi context, then the
// method's data args (classified addr/value from the method's own parameter list).
function callProxy(ctx: FnCtx, cm: CompiledMethod, self: string, pvType: TypeSpec & { kind: "template_instance" }, args: Expression[], valueWanted: boolean): string {
  const bind = ctx.cg.bindContainer(pvType.name, pvType.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return fp.isAddr ? argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(fp.type), bind)) : emitValue(ctx, arg);
  });

  // An aggregate-returning proxy method (proposerId → id) writes through a leading $ret slot. The
  // address flows through emitProposalProxyAddr (assignment/comparison contexts); a scalar-value read
  // of the aggregate would be silently wrong, so it stays a loud fidelity warning.
  if (cm.retAgg) {
    const s = allocSlot(ctx, cm.retAgg);
    ctx.lines.push(`    (call ${cm.label} ${s} ${self} (i32.const 0)${ops.length ? " " + ops.join(" ") : ""})`);
    if (!valueWanted) return "";
    ctx.cg.warn(`aggregate proxy return used as scalar value`, 0);
    return "(i64.const 0)";
  }

  const call = `(call ${cm.label} ${self} (i32.const 0)${ops.length ? " " + ops.join(" ") : ""})`;
  if (valueWanted) return cm.retKind === "i64" ? call : "(i64.const 0)";
  ctx.lines.push(cm.retKind === "i64" ? `    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: proxy method call")))}` : `    ${call}`);
  return "";
}

// Instantiate (or fetch) a ProposalVoting proxy method from its real qpi.h body, emitting a wasm function
// `(func $PV… (param $pv i32) (param $qpi i32) <data params…>)`. `pv` (the wrapped ProposalVoting) is a
// reference parameter; `qpi` is a dummy — qpi.method() calls route to the ambient host context regardless.
function compileProxyMethod(cg: Codegen, pvType: TypeSpec & { kind: "template_instance" }, proxyClass: string, method: string): CompiledMethod | null {
  let def = cg.templateMethods.get(proxyClass)?.get(method);
  if (!def) def = cg.templateMethods.get("QpiContextProposalFunctionCall")?.get(method);   // FunctionCall base
  if (!def || !def.body) return null;

  const P = pvType.args[0], D = pvType.args[1];
  const cacheKey = `proxy:${proxyClass}<${cg.typeKeyOf(P)},${cg.typeKeyOf(D)}>::${method}`;
  const cached = cg.compiledMethods.get(cacheKey);
  if (cached) return cached;

  const bind: Bindings = { types: new Map([["ProposerAndVoterHandlingType", P], ["ProposalDataType", D]]), values: new Map(), structs: new Map() };
  const fnParams = (def.fnParams ?? []).map((p) => classifyMethodParam(cg, p, bind));
  const retT = cg.substInBindings(cg.derefType(def.returnType), bind);
  const isAggRet = !cg.isVoidType(def.returnType) && cg.isAggregateType(retT);
  const retKind: "i64" | "void" = cg.isVoidType(def.returnType) || isAggRet ? "void" : "i64";
  const retAgg = isAggRet ? cg.sizeOfType(retT, bind) : undefined;

  const cm: CompiledMethod = { label: `$PV${cg.compiledMethods.size}_${proxyClass}_${method}`, fnParams, retKind, retAgg };
  cg.compiledMethods.set(cacheKey, cm);   // register before emitting so recursive/sibling calls resolve
  try {
    cg.emittedMethodOrder.push(emitProxyMethodFn(cg, cm, def, pvType, bind, proxyClass));
  } catch (e: any) {
    cg.warn(`failed to compile proxy ${cacheKey}: ${e.message}`, def.span?.line ?? 0);
    cg.compiledMethods.delete(cacheKey);
    return null;
  }
  return cm;
}

function emitProxyMethodFn(cg: Codegen, cm: CompiledMethod, def: FunctionTemplateDecl, pvType: TypeSpec & { kind: "template_instance" }, bind: Bindings, proxyClass: string): string {
  const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
  const ctx: FnCtx = {
    cg, state: empty, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: cm.retKind === "i64",
    thisBind: bind, proxyClass,
    refLocals: new Map([["pv", pvType as TypeSpec]]),   // `pv` (member) → the wrapped ProposalVoting at $pv
  };
  if (cm.retAgg) {
    ctx.retAddr = "(local.get $ret)";
    ctx.retAggSize = cm.retAgg;
  }
  // `qpi` (member) is a dummy address param; qpi.method() routes to the ambient host context.
  ctx.params!.set("qpi", { wasmType: "i32", isAddr: true, type: { kind: "name", name: "QpiContextFunctionCall" } });
  for (const p of cm.fnParams) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: cg.substInBindings(cg.derefType(p.type), bind) });

  if (def.body) collectLocals(def.body, ctx);
  if (def.body) emitStmt(ctx, def.body);

  const retParam = cm.retAgg ? "(param $ret i32) " : "";
  const paramDecls = cm.fnParams.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = cm.retKind === "i64" ? " (result i64)" : "";
  const header = `  (func ${cm.label} ${retParam}(param $pv i32) (param $qpi i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  const tail = cm.retKind === "i64" ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
}

function describeShape(e: Expression): string {
  if (!e) return "?";
  if (e.kind === "identifier") return e.name;
  if (e.kind === "member_access") return `${describeShape(e.object)}.${e.member}`;
  if (e.kind === "call") return `${describeShape(e.callee)}(${e.args.length})`;
  if (e.kind === "subscript") return `${describeShape(e.object)}[]`;
  return e.kind;
}

// QUERY_ORACLE / SUBSCRIBE_ORACLE (qpi.h:3290/3327): qpi.__qpiQueryOracle<OI::Price>(query, proc, __id_proc,
// timeout) lowers like native lite_wasm_tu.h — the host import takes (ifaceIdx, &query, sizeof(OracleQuery),
// procId, timeout/period[, notifyPrev], fee), the fee computed in-wasm by the interface's static fee function.
// The function-pointer arg only type-checks the callback natively and is dropped; procId is the synthetic
// __id_<proc> = (CONTRACT_INDEX << 22) | defLine, whose low 16 bits also key the dispatch entry.
function emitOracleQueryCall(ctx: FnCtx, expr: Expression & { kind: "template_call" }): string | null {
  const subscribe = expr.callee.kind === "member_access" && expr.callee.member === "__qpiSubscribeOracle";
  const t = expr.templateArgs[0];
  if (!t || t.kind !== "name") return null;

  const sd = ctx.cg.structOf(t, ctx.thisBind ?? NO_BIND);
  const iface = ctx.cg.resolveConst(`${t.name}::oracleInterfaceIndex`);
  const q = sd?.members.find((m): m is StructDecl => m.kind === "struct" && m.name === "OracleQuery");
  const qSize = q ? ctx.cg.layoutOfType({ kind: "inline_struct", struct: q })?.size : undefined;
  const qAddr = expr.args[0] ? emitAddr(ctx, expr.args[0]) : null;
  const idArg = expr.args[2];
  const procName = idArg?.kind === "identifier" && idArg.name.startsWith("__id_") ? idArg.name.slice(5) : null;
  const defLine = procName ? ctx.cg.memberFnLine.get(procName) : undefined;
  if (iface === null || !q || !qSize || !qAddr || defLine === undefined) return null;
  const procId = (ctx.cg.slot << 22) | (defLine & 0x3fffff);

  const feeCall = {
    kind: "call",
    callee: { kind: "identifier", name: `${t.name}::${subscribe ? "getSubscriptionFee" : "getQueryFee"}`, span: expr.span },
    args: subscribe ? [expr.args[0], expr.args[3]] : [expr.args[0]],
    span: expr.span,
  } as Expression & { kind: "call" };
  const fee = emitCallValue(ctx, feeCall);

  if (subscribe) {
    const period = `(i32.wrap_i64 ${emitValue(ctx, expr.args[3])})`;
    const prev = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[4])}) (i32.const 1))`;
    return `(i64.extend_i32_s (call $lh_subscribeOracle (i32.const ${iface}) ${qAddr} (i32.const ${qSize}) (i32.const ${procId}) ${period} ${prev} ${fee}))`;
  }
  const timeout = `(i32.wrap_i64 ${emitValue(ctx, expr.args[3])})`;
  return `(call $lh_queryOracle (i32.const ${iface}) ${qAddr} (i32.const ${qSize}) (i32.const ${procId}) ${timeout} ${fee})`;
}

function emitCall(ctx: FnCtx, expr: Expression & { kind: "call" }): void {
  // LOG_* macros expand to __logContract{Info,Debug,...}Message — a side channel that does not affect
  // state or the digest, so dropping it is behaviorally faithful.
  if (expr.callee.kind === "identifier" && expr.callee.name.startsWith("__logContract")) return;

  // ASSERT is ((void)0) in release builds (platform/assert.h) — the argument is not even evaluated,
  // so dropping the statement is behaviorally faithful.
  if (expr.callee.kind === "identifier" && expr.callee.name === "ASSERT") return;

  // LOG_PAUSE/LOG_RESUME expand to __pauseLogMessage()/__resumeLogMessage() — same log side channel
  // as __logContract*, no effect on state or the digest.
  if (expr.callee.kind === "identifier" &&
      (expr.callee.name === "__pauseLogMessage" || expr.callee.name === "__resumeLogMessage")) return;

  // ProposalVoting proxy `qpi(state.proposals).method(...)` as a statement (e.g. getProposal/vote write
  // through an out-param). Compile the real proxy method; fall back to a drop if it can't be compiled.
  if (ctx.proxyClass && emitProxySiblingCall(ctx, expr, false) !== null) return;
  if (qpiWrapperMethod(expr)) {
    emitProposalProxyCall(ctx, expr, false);
    return;
  }

  // AssetOwnership/PossessionIterator.begin()/next() — statement forms.
  if (emitAssetIter(ctx, expr, "stmt") !== null) return;

  // CALL(fn, in, out) → __qpi_call_self(fn, in, out): invoke a PRIVATE_ function of this contract,
  // passing the caller's in/out lvalues and a freshly bumped locals frame.
  if (expr.callee.kind === "identifier" && expr.callee.name === "__qpi_call_self") {
    const fnArg = expr.args[0];
    const info = fnArg?.kind === "identifier" ? (ctx.cg.privates.get(fnArg.name) ?? ctx.cg.registered.get(fnArg.name)) : undefined;
    if (info) {
      const inAddr = expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)";
      const outAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
      const locals = `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      ctx.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${locals})`);
      return;
    }
  }

  // Direct PRIVATE_ function call: `priv(qpi, state, in, out, locals)` — QUtil calls its helpers this way
  // (get_voter_balance/get_qubic_balance) instead of via the CALL macro. The callee is a registered private;
  // pass the caller's explicit in/out/locals lvalues (the locals sub-struct the caller reserved), not a fresh
  // frame. Without this the call was dropped ("unsupported call statement"), so out params stayed zero.
  if (expr.callee.kind === "identifier" && expr.args[0]?.kind === "identifier" && expr.args[0].name === "qpi") {
    // Registered PUBLIC entries are callable the same way (MsVault's isShareHolder(qpi, state, ...)).
    const info = ctx.cg.privates.get(expr.callee.name) ?? ctx.cg.registered.get(expr.callee.name);
    if (info) {
      const inAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
      const outAddr = expr.args[3] ? (emitAddr(ctx, expr.args[3]) ?? "(i32.const 0)") : "(i32.const 0)";
      const localsAddr = expr.args[4] ? (emitAddr(ctx, expr.args[4]) ?? `(call $qpiAllocLocals (i32.const ${info.localsSize}))`) : `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      ctx.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${localsAddr})`);
      return;
    }
  }

  // CALL_OTHER_CONTRACT_FUNCTION(C,f,in,out) / INVOKE_OTHER_CONTRACT_PROCEDURE(C,p,in,out,reward) → a
  // host-mediated call into the contract at C's index. Needs C's callee IDL (index + entry input type).
  if (expr.callee.kind === "identifier" && (expr.callee.name === "__qpi_call_other" || expr.callee.name === "__qpi_invoke_other")) {
    const wat = emitInterContract(ctx, expr, expr.callee.name === "__qpi_invoke_other");
    if (wat) ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(wat, "i32", "unconverted: inter-contract call")))}`);
    else ctx.cg.warn(`unsupported inter-contract call to '${expr.args[0]?.kind === "identifier" ? expr.args[0].name : "?"}' (no callee IDL)`, expr.span.line);
    return;
  }

  // QPI memory wrappers: setMemory(dst,val) / copyMemory(dst,src) / copyFromBuffer(dst,src) /
  // copyToBuffer(dst,src,tailZero). Lowered at the call site so the byte count is sizeof(dst|src) under the
  // CALLER's bindings (where a dependent member array like VoteStorageType[numOfVotes] is concrete), rather
  // than via a generic lib-fn instantiation that loses those bindings and sizes to 0.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "setMemory" || expr.callee.name === "copyMemory" || expr.callee.name === "copyFromBuffer" || expr.callee.name === "copyToBuffer")) {
    const name = expr.callee.name;
    const dstNode = expr.args[0] ? resolveAddr(ctx, expr.args[0]) : null;
    const dst = dstNode?.addr ?? (expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)");
    if (name === "setMemory") {
      const val = expr.args[1] ? emitValueIr(ctx, expr.args[1]) : ir.i64c(0);
      // $setMem is (dst, size, val).
      ctx.lines.push(`    ${ir.emit(ir.call("$setMem", addrIr(dst), ir.i32c(dstNode?.size ?? 0), ir.op("i32.wrap_i64", val)))}`);
      return;
    }
    const srcNode = expr.args[1] ? resolveAddr(ctx, expr.args[1]) : null;
    const src = srcNode?.addr ?? (expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)");
    // copyToBuffer copies sizeof(src) (the smaller object into a larger buffer); the others copy sizeof(dst).
    const size = name === "copyToBuffer" ? (srcNode?.size ?? 0) : (dstNode?.size ?? 0);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(dst), addrIr(src), ir.i32c(size)))}`);
    return;
  }

  // Low-level memory intrinsics copyMem(dst,src,n) / setMem(dst,val,n). Handled here (not only in
  // emitThisCall, which requires a `this` context) so they also lower inside lib-fn instances such as
  // copyMemory<T1,T2>'s body `copyMem(&dst, &src, sizeof(dst))` — otherwise that body emits nothing.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "copyMem" || expr.callee.name === "setMem")) {
    const dst = expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const wrapArg = (e: Expression | undefined) => ir.op("i32.wrap_i64", e ? emitValueIr(ctx, e) : ir.i64c(0));
    if (expr.callee.name === "copyMem") {
      const src = expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)";
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(dst), addrIr(src), wrapArg(expr.args[2])))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.call("$setMem", addrIr(dst), wrapArg(expr.args[1]), wrapArg(expr.args[2])))}`);
    }
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
    else ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(q.wat, q.ret === "i32" ? "i32" : "i64", "unconverted: qpi call")))}`);
    return;
  }

  ctx.cg.warn(`unsupported call statement [${describeShape(expr)}]`, expr.span.line);
}
