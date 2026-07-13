import { SCALAR_SIZE } from "./tables";
import {
  ClassTemplate,
  CompiledMethod,
  CompiledHelperMetadata,
  PrivateFunctionMetadata,
  CalleeIdl,
  StructLayout,
  CodeGenerationWarning,
  EMPTY_TEMPLATE_BINDINGS,
  TemplateBindings,
  FieldLayout,
  ContainerLayoutMetadata,
  NamespaceLookupContext,
} from "./types";
import type {
  TypeSpec,
  Expression,
  Statement,
  Declaration,
  StructDecl,
  FunctionDecl,
  FunctionTemplateDecl,
  VariableDecl,
  TemplateParam,
  ParamDecl,
  Span,
} from "../ast";
import type { Sema } from "../sema";
import { parseIntLiteral as lexParseIntLiteral } from "../lexer";
import type { PlatformCapability } from "./platform-primitives";
import { ASSET_ENUMERATION_RECORD } from "@qinit/core";

export class CodeGenerationContext {
  assetEnumerationRecord: {
    size: number;
    capacity: number;
    fields: Record<string, { offset: number; size: number }>;
  } = ASSET_ENUMERATION_RECORD;
  private sema: Sema;
  private nested: Map<string, StructDecl> = new Map(); // contract-local nested structs
  templates: Map<string, ClassTemplate> = new Map(); // qpi.h templates (HashMap, Array, ...)
  specializations: Map<string, { specArgs: TypeSpec[]; templateDeclaration: ClassTemplate }[]> = new Map(); // partial/explicit specializations keyed by template name
  globalStructs: Map<string, StructDecl> = new Map(); // qpi.h global/namespace structs
  typedefs: Map<string, TypeSpec> = new Map(); // typedef aliases
  constexprInit: Map<string, Expression> = new Map(); // named constexpr → its init expression
  constexprType: Map<string, TypeSpec> = new Map(); // named constexpr → declared scalar type
  enumConst: Map<string, bigint> = new Map(); // enum constant (NAME and Type::NAME) → value
  enumSize: Map<string, number> = new Map(); // enum type name → storage size from its underlying type (enum class X : uint8 → 1)
  enumUnderlying: Map<string, TypeSpec> = new Map(); // enum type name → declared underlying scalar type
  enumConstType: Map<string, TypeSpec> = new Map(); // enumerator name → its enum/underlying scalar type
  enumNames: Set<string> = new Set(); // every named enum type, for type-name resolution checks
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>> = new Map(); // Class → method → out-of-class def
  compiledMethods: Map<string, CompiledMethod> = new Map(); // instantiation cache key → compiled method
  emittedMethodOrder: string[] = []; // emitted WAT, in emission order (appended to module)
  private constCache: Map<string, bigint> = new Map();
  private constInProgress = new Set<string>();
  helpers: Map<string, CompiledHelperMetadata> = new Map(); // value helpers: toReturnCode(...) etc.
  helperOverloads: Map<string, CompiledHelperMetadata[]> = new Map(); // member value helpers, ALL overloads per name in declaration order; call sites rank by argument signature
  libFns: Map<string, FunctionDecl> = new Map(); // qpi.h namespace free functions (ProposalTypes::cls), keyed by qualified name; compiled lazily
  libFnOverloads: Map<string, FunctionDecl[]> = new Map(); // all non-template overloads, in source order
  libFnTemplates: Map<string, FunctionTemplateDecl[]> = new Map(); // qpi.h namespace free function TEMPLATES (isArraySortedWithoutDuplicates<T,L>), all overloads kept, instantiated per call-site arg types
  namespaceUsings: Map<string, string[]> = new Map(); // namespace scope -> directives visible to later declarations in that scope
  namespaceContexts: Map<object, NamespaceLookupContext> = new Map(); // declaration -> namespace lookup state at its definition
  privates: Map<string, PrivateFunctionMetadata> = new Map(); // PRIVATE_FUNCTION/PROCEDURE called via CALL()
  registered: Map<string, PrivateFunctionMetadata> = new Map(); // REGISTER_USER_* function/procedure, also reachable via CALL() (same entry shape)
  callees: Map<string, CalleeIdl> = new Map(); // other contracts callable via CALL_OTHER/INVOKE_OTHER (by state-type name)
  private layoutCache: Map<string, StructLayout> = new Map();
  contractStateLayout: StructLayout = { size: 0, align: 1, fields: new Map() }; // the contract's StateData (a ContractState& param in any function resolves through it)
  slot = 0; // contract slot; oracle notification ids embed it ((slot << 22) | defLine)
  gtestMode = false; // test-runner module: enable qtest host intrinsics
  memberFnLine: Map<string, number> = new Map(); // contract member function name → definition line (__id_<proc> resolution)
  warnings: CodeGenerationWarning[] = [];
  errors: CodeGenerationWarning[] = [];
  capabilities: Set<PlatformCapability> = new Set();

  constructor(sema: Sema) {
    this.sema = sema;
  }

  // ---- register declarations from the parsed TU into codegen lookup tables ----

  registerTopLevelDeclarations(
    declarations: Declaration[],
    nsPrefix = "",
    inheritedUsing: string[] = [],
  ): void {
    const scopeUsing = this.namespaceUsings.get(nsPrefix) ?? [];
    if (!this.namespaceUsings.has(nsPrefix)) this.namespaceUsings.set(nsPrefix, scopeUsing);
    const activeUsing = [...new Set([...inheritedUsing, ...scopeUsing])];
    const sourceNamespace = nsPrefix.endsWith("::") ? nsPrefix.slice(0, -2) : nsPrefix || undefined;
    for (const declaration of declarations) {
      const td = declaration.kind === "typedef_decl" ? (declaration as any) : null;
      const usingMatch =
        typeof td?.name === "string" ? /^using namespace (.+)$/.exec(td.name) : null;
      if (usingMatch) {
        if (!scopeUsing.includes(usingMatch[1])) scopeUsing.push(usingMatch[1]);
        if (!activeUsing.includes(usingMatch[1])) activeUsing.push(usingMatch[1]);
        continue;
      }
      const lookupContext: NamespaceLookupContext = {
        sourceNamespace,
        usingNamespaces: [...activeUsing],
      };
      this.namespaceContexts.set(declaration, lookupContext);
      if (declaration.kind === "namespace") {
        this.registerTopLevelDeclarations((declaration as any).body, `${nsPrefix}${(declaration as any).name}::`, activeUsing);
      } else if (declaration.kind === "extern_block") {
        this.registerTopLevelDeclarations((declaration as any).body, nsPrefix, activeUsing);
      } else if (declaration.kind === "struct") {
        const structDeclaration = declaration as StructDecl;
        this.captureMemberNamespaceContexts(structDeclaration.members, lookupContext);
        if (structDeclaration.name) {
          this.globalStructs.set(structDeclaration.name, structDeclaration);
          // Inline value/void methods of a plain (non-template) struct — e.g. ProposalDataYesNo::checkValidity
          for (const member of structDeclaration.members) {
            if (member.kind !== "function" || !(member as FunctionDecl).body) continue;
            const fn = member as FunctionDecl;
            if (fn.name.startsWith("~")) continue;
            if (!this.templateMethods.has(structDeclaration.name)) this.templateMethods.set(structDeclaration.name, new Map());
            const into = this.templateMethods.get(structDeclaration.name)!;
            const def: FunctionTemplateDecl = {
              kind: "function_template",
              name: fn.name,
              params: [],
              functionParameters: fn.params,
              returnType: fn.returnType,
              body: fn.body,
              isConstexpr: fn.isConstexpr,
              span: fn.span,
            };
            this.namespaceContexts.set(def, lookupContext);
            // overloads (isValid() vs static isValid(y,m,d,...)) are additionally keyed by arity so an arity-aware lookup picks the right one;
            const akey = `${fn.name}/${(fn.params ?? []).length}`;
            if (fn.params[0])
              into.set(`${akey}@${this.typeKey(this.derefType(fn.params[0].type))}`, def);
            if (!into.has(akey)) into.set(akey, def);
            const firstDefault = fn.params.findIndex((param) => param.defaultValue !== undefined);
            if (firstDefault >= 0) {
              for (let arity = firstDefault; arity < fn.params.length; arity++) {
                const defaultKey = `${fn.name}/${arity}`;
                if (!into.has(defaultKey)) into.set(defaultKey, def);
              }
            }
            if (!into.has(fn.name)) into.set(fn.name, def);
          }
        }
        // file-scope structs can still nest constants/enums (e.g. a contract's static constexpr)
        this.collectConstants(structDeclaration.members);
      } else if (declaration.kind === "class_template") {
        const ct = declaration as any;
        this.captureMemberNamespaceContexts(ct.members, lookupContext);
        // A template may appear several times: a forward declaration (empty body), the primary definition, and partial specializations. Specializations
        if (ct.specializationArgs) {
          if (!this.specializations.has(ct.name)) this.specializations.set(ct.name, []);
          this.specializations.get(ct.name)!.push({
            specArgs: ct.specializationArgs,
            templateDeclaration: { params: ct.params, members: ct.members, bases: ct.bases },
          });
        } else {
          const existing = this.templates.get(ct.name);
          if (!existing || (ct.members?.length ?? 0) >= existing.members.length) {
            this.templates.set(ct.name, {
              params: ct.params,
              members: ct.members,
              bases: ct.bases,
            });
          }
        }
        // Inline member methods defined with a body in the class itself (e.g. capacity()) are captured.
        // A member may itself be a function template (Array::setMem<AT>); keep that body on the
        // owning class as well so call-site argument types can complete its bindings lazily.
        for (const itemItem of ct.specializationArgs ? [] : ct.members) {
          if (
            (itemItem.kind !== "function" && itemItem.kind !== "function_template") ||
            !(itemItem as FunctionDecl | FunctionTemplateDecl).body
          )
            continue;
          const fn = itemItem as FunctionDecl | FunctionTemplateDecl;
          if (!this.templateMethods.has(ct.name)) this.templateMethods.set(ct.name, new Map());
          const into = this.templateMethods.get(ct.name)!;
          const def: FunctionTemplateDecl =
            itemItem.kind === "function_template"
              ? (itemItem as FunctionTemplateDecl)
              : {
                  kind: "function_template",
                  name: fn.name,
                  params: ct.params,
                  functionParameters: (fn as FunctionDecl).params,
                  returnType: fn.returnType,
                  body: fn.body,
                  isConstexpr: fn.isConstexpr,
                  span: fn.span,
                };
          this.namespaceContexts.set(def, lookupContext);
          const functionParameters =
            itemItem.kind === "function_template"
              ? ((itemItem as FunctionTemplateDecl).functionParameters ?? [])
              : (itemItem as FunctionDecl).params;
          const akey = `${fn.name}/${functionParameters.length}`;
          if (functionParameters[0])
            into.set(`${akey}@${this.typeKey(this.derefType(functionParameters[0].type))}`, def);
          if (!into.has(akey)) into.set(akey, def);
          if (!into.has(fn.name)) into.set(fn.name, def);
        }
      } else if (declaration.kind === "function_template" || declaration.kind === "function") {
        // out-of-class template method definition: HashMap::set, Collection::add, ...
        const fn = declaration as FunctionTemplateDecl;
        const sep = fn.name.lastIndexOf("::");
        // Single-level NS::fn free function (not Class::method): owner is neither a known template nor struct.
        const owner = sep > 0 ? fn.name.slice(0, sep) : "";
        const ownerBase = owner.includes("::") ? owner.slice(owner.lastIndexOf("::") + 2) : owner;
        const freeQualified =
          sep > 0 &&
          fn.body &&
          declaration.kind === "function" &&
          !owner.includes("::") &&
          !this.templates.has(ownerBase) &&
          !this.globalStructs.has(ownerBase);
        if (freeQualified) {
          const key = fn.name;
          const overloads = this.libFnOverloads.get(key);
          if (overloads) overloads.push(declaration as FunctionDecl);
          else this.libFnOverloads.set(key, [declaration as FunctionDecl]);
          if (!this.libFns.has(key)) this.libFns.set(key, declaration as FunctionDecl);
        } else if (sep > 0 && fn.body) {
          const cls = ownerBase;
          const method = fn.name.slice(sep + 2);
          const methodDefinition: FunctionTemplateDecl =
            declaration.kind === "function_template"
              ? fn
              : {
                  kind: "function_template",
                  name: method,
                  params: [],
                  functionParameters: (declaration as FunctionDecl).params,
                  returnType: fn.returnType,
                  body: fn.body,
                  isConstexpr: fn.isConstexpr,
                  span: fn.span,
                };
          this.namespaceContexts.set(methodDefinition, lookupContext);
          if (!this.templateMethods.has(cls)) this.templateMethods.set(cls, new Map());
          // first definition wins (skip explicit specializations like HashFunction<m256i>)
          const minto = this.templateMethods.get(cls)!;
          const makey = `${method}/${(fn.functionParameters ?? (fn as any).params ?? []).length}`;
          // An explicit specialization (`template <> HashFunction<m256i>::hash`) loses the
          // class argument in the parser's normalized name, but its concrete first parameter
          if (methodDefinition.params.length === 0 && methodDefinition.functionParameters?.length) {
            const concrete = this.derefType(methodDefinition.functionParameters[0].type);
            minto.set(`${makey}@${this.typeKey(concrete)}`, methodDefinition);
          }
          if (!minto.has(makey)) minto.set(makey, methodDefinition);
          if (!minto.has(method)) minto.set(method, methodDefinition);
        } else if (sep < 0 && declaration.kind === "function" && (declaration as FunctionDecl).body) {
          // A namespace or platform free function (__m256i_convert, ProposalTypes::cls): keyed by its qualified
          // name and compiled lazily. Platform conversion/equality helpers must remain source-backed so they
          const key = `${nsPrefix}${fn.name}`;
          const overloads = this.libFnOverloads.get(key);
          if (overloads) overloads.push(declaration as FunctionDecl);
          else this.libFnOverloads.set(key, [declaration as FunctionDecl]);
          if (!this.libFns.has(key)) this.libFns.set(key, declaration as FunctionDecl);
        } else if (sep < 0 && declaration.kind === "function_template" && fn.body) {
          // a namespace free function TEMPLATE (isArraySortedWithoutDuplicates<T,L>): keyed by qualified name, instantiated per call-site arg types (the call passes
          const key = `${nsPrefix}${fn.name}`;
          const list = this.libFnTemplates.get(key);
          if (list) list.push(fn as FunctionTemplateDecl);
          else this.libFnTemplates.set(key, [fn as FunctionTemplateDecl]);
        }
      } else if (declaration.kind === "typedef_decl") {
        this.typedefs.set(td.name, td.type);
      } else if (declaration.kind === "variable") {
        this.collectConstant(declaration as VariableDecl);
      } else if (declaration.kind === "enum") {
        this.collectEnum(declaration as any);
      }
    }
  }

  private captureMemberNamespaceContexts(
    members: Declaration[],
    context: NamespaceLookupContext,
  ): void {
    for (const member of members) {
      this.namespaceContexts.set(member, context);
      if (member.kind === "struct" || member.kind === "class_template") {
        this.captureMemberNamespaceContexts((member as StructDecl).members, context);
      }
    }
  }

  namespaceContextOf(declaration?: object | null): NamespaceLookupContext {
    return declaration
      ? (this.namespaceContexts.get(declaration) ?? { usingNamespaces: [] })
      : { usingNamespaces: [] };
  }

  /**
   * Ordered lookup keys for a free helper / lib-fn call.
   * 1. exact qualified name
   * 2. lexical sourceNamespace variant (if available)
   * 3. active `using namespace` directives (declaration order)
   * 4. bare/unqualified name (global), only when name is unqualified
   * First hit wins; no hardcoded QPI:: fallback.
   */
  namespaceCandidates(
    name: string,
    sourceNamespace?: string,
    usingNamespaces: string[] = [],
  ): string[] {
    const hasNamespace = name.includes("::");
    const keys: string[] = [];
    const add = (key: string) => {
      if (!keys.includes(key)) keys.push(key);
    };
    add(name);
    if (sourceNamespace) add(`${sourceNamespace}::${name}`);
    for (const ns of usingNamespaces) add(`${ns}::${name}`);
    if (!hasNamespace) add(name);
    return keys;
  }

  // Collect named constexpr/const-with-initializer values and enum constants from a member list.
  private collectConstants(members: Declaration[]): void {
    for (const member of members) {
      if (member.kind === "variable") this.collectConstant(member as VariableDecl);
      else if (member.kind === "enum") this.collectEnum(member as any);
    }
  }

  private registerLibFnTemplate(key: string, fn: FunctionTemplateDecl): void {
    if (!fn.body) return;
    const list = this.libFnTemplates.get(key);
    if (list) list.push(fn);
    else this.libFnTemplates.set(key, [fn]);
  }

  private collectConstant(variableDeclaration: VariableDecl): void {
    if (variableDeclaration.initializer && (variableDeclaration.isConstexpr || variableDeclaration.type.kind === "const")) {
      // User declarations are collected after the seeded qpi.h library and therefore shadow library constants with the same unqualified
      this.constexprInit.set(variableDeclaration.name, variableDeclaration.initializer);
      this.constexprType.set(variableDeclaration.name, variableDeclaration.type);
      this.enumConst.delete(variableDeclaration.name);
      this.enumConstType.delete(variableDeclaration.name);
      this.constCache.delete(variableDeclaration.name);
    }
  }

  private collectEnum(type: {
    name?: string;
    underlyingType?: TypeSpec;
    members: { name: string; value?: Expression }[];
  }): void {
    if (type.name) {
      this.enumNames.add(type.name);
    }
    if (type.name && type.underlyingType?.kind === "name") {
      const byteSize = SCALAR_SIZE[type.underlyingType.name];
      if (byteSize !== undefined) this.enumSize.set(type.name, byteSize);
      this.enumUnderlying.set(type.name, type.underlyingType);
    }
    const enumType: TypeSpec = type.underlyingType ?? { kind: "name", name: "sint32" };
    let next = 0n;
    for (const member of type.members) {
      const numericValue = member.value ? this.evalConstBig(member.value, EMPTY_TEMPLATE_BINDINGS) : next;
      next = numericValue + 1n;
      this.constexprInit.delete(member.name);
      this.constexprType.delete(member.name);
      this.enumConst.set(member.name, this.normalizeConst(numericValue, enumType));
      this.enumConstType.set(member.name, enumType);
      this.constCache.delete(member.name);
      if (type.name) {
        this.enumConst.set(`${type.name}::${member.name}`, this.normalizeConst(numericValue, enumType));
        this.enumConstType.set(`${type.name}::${member.name}`, enumType);
        this.constCache.delete(`${type.name}::${member.name}`);
      }
    }
  }

  typeOfConstant(name: string): TypeSpec | null {
    return (
      this.constexprType.get(name) ??
      this.enumConstType.get(name) ??
      (name.includes("::") ? this.typeOfConstant(name.slice(name.lastIndexOf("::") + 2)) : null)
    );
  }

  scalarStorageType(type: TypeSpec): TypeSpec {
    const dereferencedType = this.derefType(type);
    if (dereferencedType.kind !== "name") return dereferencedType;
    const base = dereferencedType.name.includes("::") ? dereferencedType.name.slice(dereferencedType.name.lastIndexOf("::") + 2) : dereferencedType.name;
    const normalized = SCALAR_SIZE[base] !== undefined ? { ...dereferencedType, name: base } : dereferencedType;
    return this.enumUnderlying.get(normalized.name) ?? normalized;
  }

  private normalizeConst(value: bigint, type: TypeSpec): bigint {
    const storageType = this.scalarStorageType(type);
    if (storageType.kind !== "name") return value;
    const size = SCALAR_SIZE[storageType.name];
    if (size === undefined || size >= 8) return value;
    if (storageType.name === "bool" || storageType.name === "bit") return value === 0n ? 0n : 1n;
    const bits = BigInt(size * 8);
    const mask = (1n << bits) - 1n;
    const narrowed = value & mask;
    if (/^(sint|signed\b)/.test(storageType.name)) {
      const sign = 1n << (bits - 1n);
      return (narrowed & sign) !== 0n ? narrowed - (1n << bits) : narrowed;
    }
    return narrowed;
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
    const initializer = this.constexprInit.get(name);
    if (initializer === undefined) {
      // A callee's index constant (`QX_CONTRACT_INDEX`) isn't declared in this contract's source, so resolve it from the provided callee
      const ci = name.match(/^(\w+)_CONTRACT_INDEX$/);
      if (ci) {
        const candidate = this.callees.get(ci[1]);
        if (candidate !== undefined) {
          this.constCache.set(name, BigInt(candidate.index));
          return BigInt(candidate.index);
        }
      }
      // namespace-qualified constant (ProposalTypes::Class::GeneralOptions): constants are collected by their unqualified name, so fall back to the tail after the
      const index = name.lastIndexOf("::");
      return index >= 0 ? this.resolveConst(name.slice(index + 2)) : null;
    }
    if (this.constInProgress.has(name)) return null; // cyclic constexpr — give up
    this.constInProgress.add(name);
    try {
      const numericValue = this.normalizeConst(
        this.evalConstBig(initializer, EMPTY_TEMPLATE_BINDINGS),
        this.constexprType.get(name) ?? { kind: "name", name: "sint64" },
      );
      this.constCache.set(name, numericValue);
      return numericValue;
    } finally {
      this.constInProgress.delete(name);
    }
  }

  // ---- struct sizing (binding-aware: template params resolve through `b`) ----

  private sizeDepth = 0;

  sizeOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    // Guard against recursive/self-referential types (a struct reachable from its own field).
    if (this.sizeDepth > 80) {
      this.warn("type nesting too deep / recursive — sized as 0", 0);
      return 0;
    }
    this.sizeDepth++;
    try {
      return this.sizeOfTypeInner(type, templateBindings);
    } finally {
      this.sizeDepth--;
    }
  }

  private sizeOfTypeInner(type: TypeSpec, templateBindings: TemplateBindings): number {
    if (type.kind === "const") return this.sizeOfType(type.valueType, templateBindings);
    if (type.kind === "reference" || type.kind === "pointer") return 4;
    if (type.kind === "void") return 0;

    if (type.kind === "array") {
      const constantValue = this.evalConst(type.size, templateBindings);
      return this.sizeOfType(type.element, templateBindings) * constantValue;
    }

    if (type.kind === "inline_struct") {
      return this.layoutOfStruct(type.struct, templateBindings).size;
    }

    if (type.kind === "name") {
      const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
      // template parameter bound to a concrete type?
      const bound = templateBindings.types.get(type.name) ?? templateBindings.types.get(baseName);
      if (bound) return this.sizeOfType(bound, templateBindings);

      const size = SCALAR_SIZE[type.name] ?? SCALAR_SIZE[baseName];
      if (size !== undefined) return size;

      const td = this.typedefs.get(type.name) ?? this.typedefs.get(baseName);
      if (td) return this.sizeOfType(td, templateBindings);

      const struct = this.structByName(type.name, templateBindings);
      if (struct) return this.layoutOfStruct(struct, templateBindings).size;

      const qn = this.qualifiedNestedType(type.name, templateBindings);
      if (qn) return this.sizeOfType(qn, templateBindings);

      // asset iterators occupy their 8-byte runtime shape (count @0, cursor @4) wherever they live
      if (/Asset(Ownership|Possession)Iterator$/.test(type.name)) return 8;

      // an enum type: sized by its declared underlying type (enum class X : uint8 → 1), default int
      const es = this.enumSize.get(type.name) ?? this.enumSize.get(type.name.split("::").pop()!);
      if (es !== undefined) return es;
      const num = parseInt(type.name);
      if (!isNaN(num)) return num; // shouldn't happen for a type, defensive
      return 4; // assume enum-sized
    }

    if (type.kind === "template_instance") {
      return this.layoutOfTemplate(type.name, type.callArguments, templateBindings).size;
    }

    if (type.kind === "dependent_member") {
      const resolvedMember = this.resolveDependentMember(type, templateBindings);
      if (resolvedMember)
        return this.sizeOfType(resolvedMember.type, resolvedMember.bindings);
      return 0;
    }

    return 0;
  }

  // Resolve a dependent member type `Selector<args>::member` (e.g. ProposalVoting's
  private resolveDependentMember(
    type: Extract<TypeSpec, { kind: "dependent_member" }>,
    templateBindings: TemplateBindings,
  ): { type: TypeSpec; bindings: TemplateBindings } | null {
    const base = type.base;
    if (base.kind !== "template_instance") return null;
    const inst = this.instantiateTemplate(base.name, base.callArguments, templateBindings);
    if (!inst) return null;

    for (const member of inst.templateDeclaration.members) {
      if (member.kind === "typedef_decl" && (member as any).name === type.member) {
        return { type: (member as any).type, bindings: inst.b };
      }
    }
    return null;
  }

  // Select the template definition for `name<args>` and build its parameter bindings. A partial/explicit
  private instantiateTemplate(
    name: string,
    callArguments: TypeSpec[],
    parent: TemplateBindings,
  ): { templateDeclaration: ClassTemplate; b: TemplateBindings } | null {
    const resolved = callArguments.map((argument) => this.resolveType(argument, parent));

    const specs = this.specializations.get(name);
    if (specs) {
      for (const spec of specs) {
        if (spec.specArgs.length !== resolved.length) continue;
        const paramByName = new Map(spec.templateDeclaration.params.map((parameter) => [parameter.name, parameter] as const));
        const templateBindings: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
        let match = true;
        for (let specArgIndex = 0; specArgIndex < spec.specArgs.length; specArgIndex++) {
          const sa = spec.specArgs[specArgIndex];
          const param = sa.kind === "name" ? paramByName.get(sa.name) : undefined;
          if (param) {
            // pattern variable — bind this specialization parameter to the instantiation argument
            if (param.kind === "type") templateBindings.types.set(param.name, resolved[specArgIndex]);
            else templateBindings.values.set(param.name, this.evalConstFromType(resolved[specArgIndex], parent));
          } else if (sa.kind === "name") {
            // concrete type to match: the argument must resolve to the same named type
            const ia = resolved[specArgIndex];
            const iaName =
              ia.kind === "name" ? ia.name : ia.kind === "template_instance" ? ia.name : "";
            if (iaName !== sa.name) {
              match = false;
              break;
            }
          } else {
            if (
              this.evalConstFromType(resolved[specArgIndex], parent) !== this.evalConstFromType(sa, parent)
            ) {
              match = false;
              break;
            }
          }
        }
        if (match) return { templateDeclaration: spec.templateDeclaration, b: this.withStaticConsts(spec.templateDeclaration, templateBindings) };
      }
    }

    // Templates register unqualified; a namespace-qualified spelling (QPI::ContractState<...>) must still hit them.
    const templateDeclaration =
      this.templates.get(name) ??
      (name.includes("::")
        ? this.templates.get(name.slice(name.lastIndexOf("::") + 2))
        : undefined);
    if (!templateDeclaration) return null;
    const templateBindings: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
    for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
      const parameter = templateDeclaration.params[parameterIndex];
      const argument =
        resolved[parameterIndex] ??
        (parameter.kind === "type" && parameter.default
          ? this.substInBindings(parameter.default, templateBindings)
          : parameter.kind === "non_type_default"
            ? ({ kind: "expr_value", expression: parameter.default } as TypeSpec)
            : undefined);
      if (!argument) continue;
      if (parameter.kind === "type") templateBindings.types.set(parameter.name, argument);
      else templateBindings.values.set(parameter.name, this.evalConstFromType(argument, parent));
    }
    return { templateDeclaration, b: this.withStaticConsts(templateDeclaration, templateBindings) };
  }

  // Evaluate a template's own static constexpr members into the bindings (BitArray::_elements = (L+63)/64, ProposalWithAllVoteData::supportScalarVotes), so a member array
  private withStaticConsts(templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings {
    for (const member of templateDeclaration.members) {
      if (member.kind !== "variable") continue;
      const variableDeclaration = member as VariableDecl;
      if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer && !templateBindings.values.has(variableDeclaration.name)) {
        try {
          templateBindings.values.set(variableDeclaration.name, this.evalConstBig(variableDeclaration.initializer, templateBindings));
        } catch {
          /* non-integer constexpr (e.g. a typedef selector flag) — not a dimension */
        }
      }
    }
    return templateBindings;
  }

  // Instantiate a template (HashMap<id,uint64,1024>, Array<T,L>, ...) and compute its exact layout by substituting type args + non-type args
  private layoutOfTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout {
    const inst = this.instantiateTemplate(name, callArguments, parent);
    const resolved = callArguments.map((argument) => this.resolveType(argument, parent));
    if (!inst) {
      return this.fallbackTemplateLayout(name, resolved, parent);
    }
    return this.layoutOfMembers(
      inst.templateDeclaration.members,
      inst.b,
      `${name}<${resolved.map((resolvedItem) => this.typeKey(resolvedItem)).join(",")}>`,
      false,
      inst.templateDeclaration.bases,
    );
  }

  // Add the struct declarations among `members` to a child binding scope so field types that reference a sibling
  private withLocalStructs(members: Declaration[], templateBindings: TemplateBindings): TemplateBindings {
    let structs = templateBindings.structs;
    for (const member of members) {
      if (member.kind === "struct" && (member as StructDecl).name) {
        if (structs === templateBindings.structs) structs = new Map(templateBindings.structs);
        structs.set((member as StructDecl).name, member as StructDecl);
      }
    }
    return structs === templateBindings.structs ? templateBindings : { types: templateBindings.types, values: templateBindings.values, structs };
  }

  // If a field's type names a sibling nested struct/union (registered in the local-struct scope), return it as an
  private inlineNestedStruct(type: TypeSpec, templateBindings: TemplateBindings): TypeSpec {
    const bare = type.kind === "const" ? type.valueType : type;
    if (bare.kind === "name") {
      const structDeclaration = templateBindings.structs.get(bare.name);
      if (structDeclaration) return { kind: "inline_struct", struct: structDeclaration };
      // A dependent spelling through a template parameter (`typename OracleInterface::OracleReply`) only resolves under these bindings — carry the resolved
      const qn = this.qualifiedNestedType(bare.name, templateBindings);
      if (qn) return qn;
    }
    return type;
  }

  private fallbackTemplateLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings): StructLayout {
    const rendered = callArguments.map((argument) => this.typeKey(argument)).join(", ");
    throw new Error(
      `template '${name}<${rendered}>' was not captured from core source; refusing an approximate layout`,
    );
  }

  // Resolve a type name to its concrete type, chasing both template-parameter bindings and contract/qpi typedefs (e.g. ProposalVotingT ->
  resolveType(type: TypeSpec, templateBindings: TemplateBindings, depth = 0): TypeSpec {
    if (depth > 24 || type.kind !== "name") return type;
    const bound = templateBindings.types.get(type.name);
    if (bound && !(bound.kind === "name" && bound.name === type.name)) {
      return this.resolveType(bound, templateBindings, depth + 1);
    }
    const td = this.typedefs.get(type.name);
    if (td && !(td.kind === "name" && td.name === type.name)) {
      return this.resolveType(td, templateBindings, depth + 1);
    }
    const qn = this.qualifiedNestedType(type.name, templateBindings);
    if (qn) return qn;
    return type;
  }

  // Resolve a member/element type that is written in terms of a parent template instance's own parameters and nested
  concreteMemberType(
    type: TypeSpec,
    parent: TypeSpec & { kind: "template_instance" },
    depth = 0,
  ): TypeSpec {
    const inst = this.instantiateTemplate(parent.name, parent.callArguments, EMPTY_TEMPLATE_BINDINGS);
    if (!inst) return type;
    const nested = new Map<string, TypeSpec>();
    for (const member of inst.templateDeclaration.members) {
      if (member.kind === "typedef_decl") nested.set((member as any).name, (member as any).type);
    }
    return this.resolveInScope(type, inst.b, nested, depth);
  }

  private resolveInScope(
    type: TypeSpec,
    scope: TemplateBindings,
    nested: Map<string, TypeSpec>,
    depth: number,
  ): TypeSpec {
    if (depth > 24) return type;
    if (type.kind === "const")
      return {
        kind: "const",
        valueType: this.resolveInScope(type.valueType, scope, nested, depth + 1),
      };
    if (type.kind === "array")
      return {
        kind: "array",
        element: this.resolveInScope(type.element, scope, nested, depth + 1),
        size: type.size,
      };
    if (type.kind === "name") {
      const bound = scope.types.get(type.name);
      if (bound && !(bound.kind === "name" && bound.name === type.name))
        return this.resolveInScope(bound, scope, nested, depth + 1);
      const nt = nested.get(type.name);
      if (nt && !(nt.kind === "name" && nt.name === type.name))
        return this.resolveInScope(nt, scope, nested, depth + 1);
      const td = this.typedefs.get(type.name);
      if (td && !(td.kind === "name" && td.name === type.name))
        return this.resolveInScope(td, scope, nested, depth + 1);
      const qn = this.qualifiedNestedType(type.name, scope);
      if (qn) return qn;
      return type;
    }
    if (type.kind === "template_instance") {
      const callArguments = type.callArguments.map((argument) => {
        // a non-type arg given as a name that resolves to a member constexpr / param value → its literal
        if (argument.kind === "name" && scope.values.has(argument.name)) {
          return {
            kind: "expr_value",
            expression: {
              kind: "int_literal",
              value: scope.values.get(argument.name)!.toString(),
              span: { start: 0, end: 0, line: 0, column: 0 },
            },
          } as TypeSpec;
        }
        return this.resolveInScope(argument, scope, nested, depth + 1);
      });
      return { kind: "template_instance", name: type.name, callArguments };
    }
    return type;
  }

  // Public: substitute a type through bindings (T→sint64, L→4) — turns a template free fn's param type `Array<T,L>` into
  substInBindings(type: TypeSpec, bind: TemplateBindings): TypeSpec {
    return this.resolveInScope(type, bind, new Map(), 0);
  }

  // Public: recover the integer value of a (possibly value-) template arg, e.g. the `4` of Array<sint64,4>.
  valueOfTypeArg(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint {
    return this.evalConstFromType(type, templateBindings);
  }

  private evalConstFromType(type: TypeSpec, templateBindings: TemplateBindings): bigint {
    // A non-type template arg arrives as a TypeSpec; recover its integer value.
    if (type.kind === "expr_value") return this.evalConstBig(type.expression, templateBindings);
    if (type.kind === "name") {
      const numericValue = templateBindings.values.get(type.name);
      if (numericValue !== undefined) return numericValue;
      const count = parseInt(type.name);
      if (!isNaN(count)) return BigInt(count);
      // a named constant template arg (e.g. Array<RoundInfo, QEARN_MAX_EPOCHS>)
      const resolvedConstant = this.resolveConst(type.name);
      if (resolvedConstant !== null) return resolvedConstant;
    }
    return 0n;
  }

  layoutOf(struct: StructDecl): StructLayout {
    return this.layoutOfStruct(struct, EMPTY_TEMPLATE_BINDINGS);
  }

  // A base class contributes its fields (laid out at the start of the derived object) and its static
  private baseContribution(
    baseType: TypeSpec,
    parentB: TemplateBindings,
  ): { layout: StructLayout; consts: Map<string, bigint> } | null {
    let resolvedBaseType: TypeSpec = baseType;
    if (resolvedBaseType.kind === "name") {
      const bound = parentB.types.get(resolvedBaseType.name);
      if (bound) resolvedBaseType = bound;
      else {
        const td = this.typedefs.get(resolvedBaseType.name);
        if (td) resolvedBaseType = td;
      }
    }

    if (resolvedBaseType.kind === "template_instance") {
      const templateDeclaration = this.templates.get(resolvedBaseType.name);
      if (!templateDeclaration)
        return {
          layout: this.layoutOfTemplate(resolvedBaseType.name, resolvedBaseType.callArguments, parentB),
          consts: new Map(),
        };
      const templateBindings: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
      const resolved = resolvedBaseType.callArguments.map((argument) => this.resolveType(argument, parentB));
      for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
        const parameter = templateDeclaration.params[parameterIndex];
        const argument = resolved[parameterIndex];
        if (!argument) continue;
        if (parameter.kind === "type") templateBindings.types.set(parameter.name, argument);
        else templateBindings.values.set(parameter.name, this.evalConstFromType(argument, parentB));
      }
      const consts = new Map<string, bigint>();
      for (const member of templateDeclaration.members) {
        if (member.kind !== "variable") continue;
        const variableDeclaration = member as VariableDecl;
        if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer && !templateBindings.values.has(variableDeclaration.name)) {
          try {
            const val = this.evalConstBig(variableDeclaration.initializer, templateBindings);
            templateBindings.values.set(variableDeclaration.name, val);
            consts.set(variableDeclaration.name, val);
          } catch {
            /* a non-integer static constexpr (e.g. a bool selector) — not a dimension */
          }
        }
      }
      const layout = this.layoutOfMembers(
        templateDeclaration.members,
        templateBindings,
        `${resolvedBaseType.name}<${resolved.map((resolvedItem) => this.typeKey(resolvedItem)).join(",")}>`,
        false,
        templateDeclaration.bases,
      );
      return { layout, consts };
    }

    if (resolvedBaseType.kind === "name") {
      const struct = this.structByName(resolvedBaseType.name, parentB);
      if (struct) {
        const consts = new Map<string, bigint>();
        for (const member of struct.members) {
          if (member.kind !== "variable") continue;
          const variableDeclaration = member as VariableDecl;
          if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer) {
            try {
              consts.set(variableDeclaration.name, this.evalConstBig(variableDeclaration.initializer, parentB));
            } catch {
              /* not a dimension */
            }
          }
        }
        const layout = this.layoutOfMembers(
          struct.members,
          parentB,
          this.structCacheKey(struct),
          struct.isUnion,
          struct.bases,
        );
        return { layout, consts };
      }
    }
    return null;
  }

  // Evaluate a `TypeName::member` static constexpr. Resolves TypeName through the current bindings and
  private evalQualifiedConst(typeName: string, member: string, templateBindings: TemplateBindings): bigint | null {
    let type: TypeSpec = { kind: "name", name: typeName };
    for (let index = 0; index < 8 && type.kind === "name"; index++) {
      const bound = templateBindings.types.get(type.name);
      if (bound) {
        type = bound;
        continue;
      }
      const td = this.typedefs.get(type.name);
      if (td) {
        type = td;
        continue;
      }
      break;
    }

    let members: Declaration[] | null = null;
    let tb: TemplateBindings = templateBindings;
    if (type.kind === "template_instance") {
      const templateDeclaration = this.templates.get(type.name);
      if (!templateDeclaration) return null;
      members = templateDeclaration.members;
      tb = { types: new Map(), values: new Map(), structs: new Map() };
      const resolved = type.callArguments.map((argument) => this.resolveType(argument, templateBindings));
      for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
        const parameter = templateDeclaration.params[parameterIndex];
        const argument = resolved[parameterIndex];
        if (!argument) continue;
        if (parameter.kind === "type") tb.types.set(parameter.name, argument);
        else tb.values.set(parameter.name, this.evalConstFromType(argument, templateBindings));
      }
    } else if (type.kind === "name") {
      const structDeclaration = this.structByName(type.name, templateBindings);
      if (!structDeclaration) return null;
      members = structDeclaration.members;
    }
    if (!members) return null;

    for (const memberDeclaration of members) {
      if (memberDeclaration.kind !== "variable") continue;
      const variableDeclaration = memberDeclaration as VariableDecl;
      if (variableDeclaration.name === member && variableDeclaration.initializer) {
        try {
          return this.evalConstBig(variableDeclaration.initializer, tb);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // A layout cache key unique to each struct DECLARATION, not its (possibly shared) name. Two distinct structs
  private structKeys = new WeakMap<StructDecl, string>();
  private structKeyCounter = 0;
  private structCacheKey(struct: StructDecl): string {
    let text = this.structKeys.get(struct);
    if (text === undefined) {
      text = `${struct.name}#${this.structKeyCounter++}`;
      this.structKeys.set(struct, text);
    }
    return text;
  }

  private layoutOfStruct(struct: StructDecl, templateBindings: TemplateBindings): StructLayout {
    return this.layoutOfMembers(
      struct.members,
      templateBindings,
      this.structCacheKey(struct),
      struct.isUnion,
      struct.bases,
    );
  }

  private inProgress = new Set<string>();

  private bindingSig(templateBindings: TemplateBindings): string {
    if (templateBindings.types.size + templateBindings.values.size === 0) return "";
    const ts = [...templateBindings.types].map(([k, v]) => `${k}=${this.typeKey(v)}`).join(",");
    const vs = [...templateBindings.values].map(([k, v]) => `${k}=${v}`).join(",");
    return `|${ts}|${vs}`;
  }

  private layoutOfMembers(
    members: Declaration[],
    bIn: TemplateBindings,
    cacheKey: string,
    isUnion = false,
    bases: TypeSpec[] = [],
  ): StructLayout {
    // Cache by a binding-aware key so each concrete instantiation is computed once (avoids the exponential blowup of deeply
    const key = cacheKey ? cacheKey + this.bindingSig(bIn) : "";
    if (key) {
      const cached = this.layoutCache.get(key);
      if (cached) return cached;
      // Cycle breaker: a type reachable from its own field returns an empty back-edge layout.
      if (this.inProgress.has(key)) return { size: 0, align: 1, fields: new Map() };
      this.inProgress.add(key);
    }

    try {
      const templateBindings = this.withLocalStructs(members, bIn);
      const fields = new Map<string, FieldLayout>();
      let offset = 0;
      let maxAlign = 1;

      if (isUnion) {
        let max = 0;
        for (const member of members) {
          if (member.kind === "variable") {
            const variableDeclaration = member as VariableDecl;
            if (variableDeclaration.isStatic || variableDeclaration.isConstexpr) continue;
            const byteSize = this.sizeOfType(variableDeclaration.type, templateBindings);
            const al = this.alignOfTypeB(variableDeclaration.type, templateBindings);
            fields.set(variableDeclaration.name, {
              name: variableDeclaration.name,
              offset: 0,
              size: byteSize,
              type: this.inlineNestedStruct(variableDeclaration.type, templateBindings),
            });
            if (byteSize > max) max = byteSize;
            if (al > maxAlign) maxAlign = al;
          }
        }
        const layout = { size: max, align: maxAlign, fields };
        if (key) this.layoutCache.set(key, layout);
        return layout;
      }

      // Base classes occupy the start of the object: each base's fields are placed at the current offset and
      let memberVals = templateBindings.values;
      for (const baseType of bases) {
        const bc = this.baseContribution(baseType, templateBindings);
        if (!bc) continue;
        offset = this.alignUp(offset, bc.layout.align);
        for (const bf of bc.layout.fields.values()) {
          fields.set(bf.name, {
            name: bf.name,
            offset: offset + bf.offset,
            size: bf.size,
            type: bf.type,
          });
        }
        offset += bc.layout.size;
        if (bc.layout.align > maxAlign) maxAlign = bc.layout.align;
        if (bc.consts.size) {
          if (memberVals === templateBindings.values) memberVals = new Map(templateBindings.values);
          for (const [k, v] of bc.consts) if (!memberVals.has(k)) memberVals.set(k, v);
        }
      }

      // Nested typedefs (a template may alias its own params or define a dependent storage type, e.g.
      let memberTypes = templateBindings.types;
      for (const member of members) {
        if (member.kind !== "typedef_decl") continue;
        const td = member as any;
        if (memberTypes === templateBindings.types) memberTypes = new Map(templateBindings.types);
        if (!memberTypes.has(td.name)) memberTypes.set(td.name, td.type);
      }
      const bMem =
        memberVals === templateBindings.values && memberTypes === templateBindings.types
          ? templateBindings
          : { types: memberTypes, values: memberVals, structs: templateBindings.structs };

      for (const memberCandidate of members) {
        // An anonymous struct/union (no name, no declarator) promotes its members into this struct at the current offset (`union
        if (memberCandidate.kind === "struct" && !(memberCandidate as StructDecl).name) {
          const sub = this.layoutOfStruct(memberCandidate as StructDecl, bMem);
          offset = this.alignUp(offset, sub.align);
          for (const itemItem of sub.fields.values())
            fields.set(itemItem.name, {
              name: itemItem.name,
              offset: offset + itemItem.offset,
              size: itemItem.size,
              type: itemItem.type,
            });
          offset += sub.size;
          if (sub.align > maxAlign) maxAlign = sub.align;
          continue;
        }
        if (memberCandidate.kind !== "variable") continue;
        const variableDeclaration = memberCandidate as VariableDecl;
        if (variableDeclaration.isStatic || variableDeclaration.isConstexpr) continue;
        const byteSize = this.sizeOfType(variableDeclaration.type, bMem);
        const align = Math.min(this.alignOfTypeB(variableDeclaration.type, bMem), 8);
        offset = this.alignUp(offset, align);
        fields.set(variableDeclaration.name, {
          name: variableDeclaration.name,
          offset,
          size: byteSize,
          type: this.inlineNestedStruct(variableDeclaration.type, bMem),
        });
        offset += byteSize;
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

  private alignOfTypeB(type: TypeSpec, templateBindings: TemplateBindings): number {
    if (type.kind === "const") return this.alignOfTypeB(type.valueType, templateBindings);
    if (type.kind === "reference" || type.kind === "pointer") return 4;
    if (type.kind === "array") return this.alignOfTypeB(type.element, templateBindings);
    // For aggregates, reuse the (cached) layout's computed alignment — avoids a second, uncached recursive walk that blows up
    if (type.kind === "inline_struct") return this.layoutOfStruct(type.struct, templateBindings).align;
    if (type.kind === "name") {
      const bound = templateBindings.types.get(type.name);
      if (bound) return this.alignOfTypeB(bound, templateBindings);
      const SCALAR_SIZEItem = SCALAR_SIZE[type.name];
      if (SCALAR_SIZEItem !== undefined) return Math.min(SCALAR_SIZEItem, 8);
      const td = this.typedefs.get(type.name);
      if (td) return this.alignOfTypeB(td, templateBindings);
      const struct = this.structByName(type.name, templateBindings);
      if (struct) return this.layoutOfStruct(struct, templateBindings).align;
      const es = this.enumSize.get(type.name) ?? this.enumSize.get(type.name.split("::").pop()!);
      if (es !== undefined) return es;
      return 4;
    }
    if (type.kind === "template_instance") {
      if (this.templates.get(type.name)) return this.layoutOfTemplate(type.name, type.callArguments, templateBindings).align;
      if (type.name === "Array") return Math.min(this.alignOfTypeB(type.callArguments[0], templateBindings), 8);
      return 8;
    }
    if (type.kind === "dependent_member") {
      const resolvedMember = this.resolveDependentMember(type, templateBindings);
      if (resolvedMember)
        return this.alignOfTypeB(resolvedMember.type, resolvedMember.bindings);
      return 1;
    }
    return 8;
  }

  private typeKey(type: TypeSpec): string {
    if (type.kind === "name") return type.name;
    if (type.kind === "template_instance")
      return `${type.name}<${type.callArguments.map((argument) => this.typeKey(argument)).join(",")}>`;
    if (type.kind === "const") return "c" + this.typeKey(type.valueType);
    if (type.kind === "array") return `${this.typeKey(type.element)}[]`;
    if (type.kind === "pointer") return "*";
    if (type.kind === "expr_value") return `#${this.evalConst(type.expression)}`;
    // inline-carried struct as a template arg (Array<Order,256> resolved through its declaring scope): key by tag + field names
    if (type.kind === "inline_struct") {
      const fields = type.struct.members
        .filter((member) => member.kind === "variable")
        .map((variableDeclaration) => (variableDeclaration as VariableDecl).name)
        .join(",");
      return `s:${type.struct.name || "anon"}{${fields}}`;
    }
    return "?";
  }

  private alignDepth = 0;

  private structAlign(members: Declaration[], templateBindings: TemplateBindings): number {
    if (this.alignDepth > 80) return 8;
    this.alignDepth++;
    try {
      let argument = 1;
      for (const member of members) {
        if (
          member.kind === "variable" &&
          !(member as VariableDecl).isStatic &&
          !(member as VariableDecl).isConstexpr
        ) {
          argument = Math.max(argument, this.alignOfTypeB((member as VariableDecl).type, templateBindings));
        }
      }
      return Math.min(argument, 8);
    } finally {
      this.alignDepth--;
    }
  }

  // Evaluate a constant expression, resolving template non-type params (e.g. L) through `b.values`.
  evalConst(expression: Expression, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    return Number(this.evalConstBig(expression, templateBindings));
  }

  // Parse an integer literal token (hex/bin/octal/dec, with optional u/l/ull suffixes) to a bigint.
  private parseIntLiteral(value: string): bigint {
    try {
      return lexParseIntLiteral(value);
    } catch {
      return 0n;
    }
  }

  evalConstBig(expression: Expression, templateBindings: TemplateBindings): bigint {
    switch (expression.kind) {
      case "int_literal":
        return this.parseIntLiteral(expression.value);
      case "bool_literal":
        return expression.value ? 1n : 0n;
      case "char_literal":
        return BigInt(expression.value);
      case "paren":
        return this.evalConstBig(expression.expression, templateBindings);
      case "identifier": {
        const numericValue = templateBindings.values.get(expression.name);
        if (numericValue !== undefined) return numericValue;
        // Qualified static constexpr `T::member` (e.g. ProposalVoting's maxProposals =
        const sep = expression.name.lastIndexOf("::");
        if (sep > 0) {
          const numericValue = this.evalQualifiedConst(expression.name.slice(0, sep), expression.name.slice(sep + 2), templateBindings);
          if (numericValue !== null) return numericValue;
        }
        const resolvedConstant = this.resolveConst(expression.name);
        if (resolvedConstant !== null) return resolvedConstant;
        return 0n;
      }
      case "unary_op": {
        const constantValue = this.evalConstBig(expression.argument, templateBindings);
        if (expression.operator === "-") return -constantValue;
        if (expression.operator === "~") return ~constantValue;
        if (expression.operator === "!") return constantValue === 0n ? 1n : 0n;
        return constantValue;
      }
      case "binary_op": {
        const constantValue = this.evalConstBig(expression.left, templateBindings);
        const constantValueCandidate = this.evalConstBig(expression.right, templateBindings);
        switch (expression.operator) {
          case "+":
            return constantValue + constantValueCandidate;
          case "-":
            return constantValue - constantValueCandidate;
          case "*":
            return constantValue * constantValueCandidate;
          case "/":
            return constantValueCandidate === 0n ? 0n : constantValue / constantValueCandidate;
          case "%":
            return constantValueCandidate === 0n ? 0n : constantValue % constantValueCandidate;
          case "<<":
            return constantValue << constantValueCandidate;
          case ">>":
            return constantValue >> constantValueCandidate;
          case "&":
            return constantValue & constantValueCandidate;
          case "|":
            return constantValue | constantValueCandidate;
          case "^":
            return constantValue ^ constantValueCandidate;
          case "<":
            return constantValue < constantValueCandidate ? 1n : 0n;
          case ">":
            return constantValue > constantValueCandidate ? 1n : 0n;
          case "<=":
            return constantValue <= constantValueCandidate ? 1n : 0n;
          case ">=":
            return constantValue >= constantValueCandidate ? 1n : 0n;
          case "==":
            return constantValue === constantValueCandidate ? 1n : 0n;
          case "!=":
            return constantValue !== constantValueCandidate ? 1n : 0n;
          default:
            return 0n;
        }
      }
      case "ternary":
        return this.evalConstBig(expression.condition, templateBindings) !== 0n
          ? this.evalConstBig(expression.then, templateBindings)
          : this.evalConstBig(expression.else_, templateBindings);
      case "sizeof_type":
        return BigInt(this.sizeOfType(expression.type, templateBindings));
      case "c_cast":
      case "static_cast":
        return this.normalizeConst(this.evalConstBig(expression.expression, templateBindings), expression.type);
      case "call":
      case "template_call": {
        // QPI safe-math helpers appear in constexpr contexts (e.g. QUTIL_MAX_NEW_POLL = div(MAX_POLL, 4)).
        const callee = expression.callee;
        const fn =
          callee.kind === "identifier"
            ? callee.name
            : callee.kind === "qualified_name"
              ? callee.name
              : null;
        if (fn) {
          const numericValue = expression.callArguments.map((argument) => this.evalConstBig(argument, templateBindings));
          switch (fn) {
            case "div":
              return numericValue[1] === 0n ? 0n : numericValue[0] / numericValue[1];
            case "mod":
              return numericValue[1] === 0n ? 0n : numericValue[0] % numericValue[1];
            case "min":
              return numericValue[0] <= numericValue[1] ? numericValue[0] : numericValue[1];
            case "max":
              return numericValue[0] >= numericValue[1] ? numericValue[0] : numericValue[1];
            case "abs":
              return numericValue[0] < 0n ? -numericValue[0] : numericValue[0];
          }
        }
        return 0n;
      }
      default:
        return 0n;
    }
  }

  private alignUp(count: number, argument: number): number {
    return Math.ceil(count / argument) * argument;
  }

  // ---- collect nested structs ----

  collectNested(contract: StructDecl): void {
    for (const member of contract.members) {
      if (member.kind === "struct") {
        const structDeclaration = member as StructDecl;
        this.nested.set(structDeclaration.name, structDeclaration);
        this.captureStructMethods(structDeclaration, [structDeclaration.name]);
        // Also register structs nested INSIDE this one under their qualified name (`Outer::Inner`), recursively.
        this.collectNestedStructs(structDeclaration, structDeclaration.name);
      } else if (member.kind === "variable") {
        this.collectConstant(member as VariableDecl);
      } else if (member.kind === "enum") {
        this.collectEnum(member as any);
      } else if (member.kind === "typedef_decl") {
        // contract-member typedef (typedef Order _Order;) — register the alias so _Order-typed locals resolve their layout/fields.
        const td = member as any;
        if (!this.typedefs.has(td.name)) this.typedefs.set(td.name, td.type);
      } else if (member.kind === "class_template") {
        // contract-nested template struct (PULSE's HashMapConverter<Key,T,L>): register like a file-scope template — the layout table AND its inline methods
        const ct = member as any;
        const prev = this.templates.get(ct.name);
        if (!prev || (prev.members?.length ?? 0) < (ct.members?.length ?? 0))
          this.templates.set(ct.name, ct);
        for (const mm of ct.specializationArgs ? [] : ct.members) {
          if (mm.kind !== "function" || !(mm as FunctionDecl).body) continue;
          const fn = mm as FunctionDecl;
          if (!this.templateMethods.has(ct.name)) this.templateMethods.set(ct.name, new Map());
          const into = this.templateMethods.get(ct.name)!;
          const def: FunctionTemplateDecl = {
            kind: "function_template",
            name: fn.name,
            params: ct.params,
            functionParameters: fn.params,
            returnType: fn.returnType,
            body: fn.body,
            isConstexpr: fn.isConstexpr,
            span: fn.span,
          };
          const akey = `${fn.name}/${(fn.params ?? []).length}`;
          if (!into.has(akey)) into.set(akey, def);
          if (!into.has(fn.name)) into.set(fn.name, def);
        }
      } else if (member.kind === "function_template") {
        // Static function templates declared directly on the contract (QBond/RandomLottery/Pulse
        // min/max) are ordinary source helpers, not class-layout methods. Register them under the
        this.registerLibFnTemplate((member as FunctionTemplateDecl).name, member as FunctionTemplateDecl);
      }
    }
  }

  // Register nested declarations from a callee contract translation unit under `${name}::`.
  registerCalleeContractDeclarations(name: string, declarations: Declaration[]): void {
    for (const declaration of declarations) {
      if (declaration.kind === "variable") {
        this.collectConstant(declaration as VariableDecl);
      } else if (declaration.kind === "enum") {
        this.collectEnum(declaration as any);
      } else if (declaration.kind === "struct") {
        const structDeclaration = declaration as StructDecl;
        if (!structDeclaration.bases?.some((baseType) => baseType.kind === "name" && baseType.name === "ContractBase")) continue;
        for (const member of structDeclaration.members) {
          if (member.kind === "struct") {
            const nested = member as StructDecl;
            this.globalStructs.set(`${name}::${nested.name}`, nested);
            this.collectNestedStructs(nested, `${name}::${nested.name}`);
          } else if (member.kind === "typedef_decl") {
            const td = member as { name: string; type: TypeSpec };
            this.typedefs.set(`${name}::${td.name}`, td.type);
            if (!this.typedefs.has(td.name)) this.typedefs.set(td.name, td.type);
          } else if (member.kind === "function") {
            const fn = member as FunctionDecl;
            if (!fn.body || !fn.isStatic) continue;
            const key = `${name}::${fn.name}`;
            if (!this.libFns.has(key)) this.libFns.set(key, fn);
          } else if (member.kind === "function_template") {
            // Callee templates are needed by qualified source calls such as RL::min/max. The
            // parser currently drops the `static` bit on FunctionTemplateDecl, but contract-level
            const fn = member as FunctionTemplateDecl;
            this.registerLibFnTemplate(`${name}::${fn.name}`, fn);
          }
        }
      }
    }
  }

  // Inline methods of a nested struct (WinnerData::isValid, EscrowAsset::setFrom) dispatch through templateMethods like any plain-struct method — capture them
  private captureStructMethods(structDeclaration: StructDecl, names: string[]): void {
    for (const mm of structDeclaration.members) {
      if (mm.kind !== "function" || !(mm as FunctionDecl).body) continue;
      const fn = mm as FunctionDecl;
      if (fn.name.startsWith("~")) continue;
      const def: FunctionTemplateDecl = {
        kind: "function_template",
        name: fn.name,
        params: [],
        functionParameters: fn.params,
        returnType: fn.returnType,
        body: fn.body,
        isConstexpr: fn.isConstexpr,
        span: fn.span,
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
    for (const member of parent.members) {
      if (member.kind === "struct") {
        const structDeclaration = member as StructDecl;
        const key = `${prefix}::${structDeclaration.name}`;
        if (!this.nested.has(key)) this.nested.set(key, structDeclaration);
        // Also register the unqualified name so a bare reference written inside the declaring struct (e.g. `Array<TableEntry, 512> info;`
        if (!this.nested.has(structDeclaration.name) && !this.globalStructs.has(structDeclaration.name)) this.nested.set(structDeclaration.name, structDeclaration);
        this.captureStructMethods(structDeclaration, [structDeclaration.name, key]);
        this.collectNestedStructs(structDeclaration, key);
      }
    }
  }

  // ---- type → layout / field resolution (used by body codegen for address computation) ----

  alignOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
    return this.alignOfTypeB(type, templateBindings);
  }

  // Resolve a struct by name across the binding / nested / global tables. Falls back to the unqualified
  structByName(name: string, templateBindings: TemplateBindings): StructDecl | undefined {
    const hit = templateBindings.structs.get(name) ?? this.nested.get(name) ?? this.globalStructs.get(name);
    if (hit) return hit;
    const index = name.lastIndexOf("::");
    if (index >= 0) {
      const text = name.slice(index + 2);
      return templateBindings.structs.get(text) ?? this.nested.get(text) ?? this.globalStructs.get(text);
    }
    return undefined;
  }

  // `Head::Nested[::Deeper]` where Head is a template-parameter binding, a typedef, or a (possibly namespace-qualified) struct name (`typename OracleInterface::OracleReply` with
  qualifiedNestedType(name: string, templateBindings: TemplateBindings): TypeSpec | null {
    for (let sep = name.indexOf("::"); sep > 0; sep = name.indexOf("::", sep + 2)) {
      const head = name.slice(0, sep);
      const headT = templateBindings.types.get(head) ?? this.typedefs.get(head);
      let sd = headT ? this.structOf(headT, templateBindings) : (this.structByName(head, templateBindings) ?? null);
      if (!sd) continue;

      const segs = name.slice(sep + 2).split("::");
      const walked = this.walkNestedSegments(sd, segs, templateBindings);
      if (walked) return walked;
    }
    return null;
  }

  private walkNestedSegments(sd: StructDecl | null, segs: string[], templateBindings: TemplateBindings): TypeSpec | null {
    for (let segmentIndex = 0; segmentIndex < segs.length; segmentIndex++) {
      if (!sd) return null;
      const seg = segs[segmentIndex];
      const last = segmentIndex === segs.length - 1;
      const ms = sd.members.find((member): member is StructDecl => member.kind === "struct" && member.name === seg);
      if (ms) {
        if (last) return { kind: "inline_struct", struct: ms, span: ms.span };
        sd = ms;
        continue;
      }
      const mt = sd.members.find(
        (member) => member.kind === "typedef_decl" && (member as any).name === seg,
      ) as any;
      if (!mt) return null;
      if (last) return mt.type;
      sd = this.structOf(mt.type, templateBindings);
    }
    return null;
  }

  // Strip const/reference wrappers to the underlying type (a by-ref aggregate param holds an address to this type, and
  derefType(type: TypeSpec): TypeSpec {
    if (type.kind === "const") return this.derefType(type.valueType);
    if (type.kind === "reference") return this.derefType(type.referentType);
    return type;
  }

  // True for a void return type. The parser spells void with both {kind:"void"} nodes and dedicated tokens.
  isVoidType(type: TypeSpec): boolean {
    const dereferencedType = this.derefType(type);
    return dereferencedType.kind === "void" || (dereferencedType.kind === "name" && dereferencedType.name === "void");
  }

  // True if a type is an aggregate (id/m256i/struct/array/container) — passed/returned by address rather than as an i64 value.
  isAggregateType(type: TypeSpec): boolean {
    if (type.kind === "const") return this.isAggregateType(type.valueType);
    if (type.kind === "reference") return this.isAggregateType(type.referentType);
    if (type.kind === "array" || type.kind === "inline_struct" || type.kind === "template_instance")
      return true;
    if (type.kind === "name") {
      const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
      if (
        baseName === "id" ||
        baseName === "m256i" ||
        baseName === "__m256i" ||
        baseName === "uint128" ||
        baseName === "uint128_t"
      )
        return true;
      if (SCALAR_SIZE[type.name] !== undefined || SCALAR_SIZE[baseName] !== undefined) return false;
      return this.layoutOfType(type) !== null;
    }
    return false;
  }

  // Resolve a struct-ish type to its (cached) field layout, or null for scalars/containers.
  layoutOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout | null {
    if (type.kind === "const") return this.layoutOfType(type.valueType, templateBindings);
    if (type.kind === "inline_struct") return this.layoutOfStruct(type.struct, templateBindings);
    if (type.kind === "template_instance") {
      return this.templates.get(type.name) ? this.layoutOfTemplate(type.name, type.callArguments, templateBindings) : null;
    }
    if (type.kind === "name") {
      const baseName = type.name.includes("::") ? type.name.slice(type.name.lastIndexOf("::") + 2) : type.name;
      const bound = templateBindings.types.get(type.name) ?? templateBindings.types.get(baseName);
      if (bound) return this.layoutOfType(bound, templateBindings);
      if (SCALAR_SIZE[type.name] !== undefined || SCALAR_SIZE[baseName] !== undefined) return null;
      const td = this.typedefs.get(type.name) ?? this.typedefs.get(baseName);
      if (td) return this.layoutOfType(td, templateBindings);
      const structDeclaration = this.structByName(type.name, templateBindings);
      if (structDeclaration) return this.layoutOfStruct(structDeclaration, templateBindings);
      const qn = this.qualifiedNestedType(type.name, templateBindings);
      if (qn) return this.layoutOfType(qn, templateBindings);
    }
    return null;
  }

  // Resolve a type to its StructDecl (for inline member-method lookup), following typedefs/bindings.
  structOf(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructDecl | null {
    if (type.kind === "const") return this.structOf(type.valueType, templateBindings);
    if (type.kind === "reference") return this.structOf(type.referentType, templateBindings);
    if (type.kind === "inline_struct") return type.struct;
    if (type.kind === "name") {
      const bound = templateBindings.types.get(type.name);
      if (bound) return this.structOf(bound, templateBindings);
      const td = this.typedefs.get(type.name);
      if (td) return this.structOf(td, templateBindings);
      const structDeclaration = this.structByName(type.name, templateBindings);
      if (structDeclaration) return structDeclaration;
      const qn = this.qualifiedNestedType(type.name, templateBindings);
      return qn ? this.structOf(qn, templateBindings) : null;
    }
    return null;
  }

  // Look up a field within a struct-ish type, returning its offset/size/type.
  fieldOf(type: TypeSpec, member: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): FieldLayout | null {
    const layout = this.layoutOfType(type, templateBindings);
    return layout ? (layout.fields.get(member) ?? null) : null;
  }

  // ---- public helpers for compiling instantiated container methods ----

  typeKeyOf(type: TypeSpec): string {
    return this.typeKey(type);
  }

  // The full layout of a container instantiation (HashMap<id,uint64,1024> → _elements/_occupationFlags/...).
  containerLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout {
    // A plain (non-template) struct dispatched as a zero-arg instance (ProposalDataYesNo, or a contract- nested WinnerData) has no template
    if (!this.templates.has(name) && !this.specializations.has(name)) {
      const structDeclaration = this.globalStructs.get(name) ?? this.nested.get(name);
      if (structDeclaration) return this.layoutOfStruct(structDeclaration, templateBindings);
    }
    return this.layoutOfTemplate(name, callArguments, templateBindings);
  }

  // template params → concrete args (KeyT→id, L→1024), including authoritative defaults such as
  // HashFunc = HashFunction<KeyT>.
  bindContainer(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): TemplateBindings {
    const templateDeclaration = this.templates.get(name);
    const out: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };
    if (!templateDeclaration) return out;
    const resolved = callArguments.map((argument) => this.resolveType(argument, templateBindings));
    for (let parameterIndex = 0; parameterIndex < templateDeclaration.params.length; parameterIndex++) {
      const parameter = templateDeclaration.params[parameterIndex];
      const argument =
        resolved[parameterIndex] ??
        (parameter.kind === "type" && parameter.default
          ? this.substInBindings(parameter.default, out)
          : parameter.kind === "non_type_default"
            ? ({ kind: "expr_value", expression: parameter.default } as TypeSpec)
            : undefined);
      if (!argument) continue;
      if (parameter.kind === "type") out.types.set(parameter.name, argument);
      else out.values.set(parameter.name, this.evalConstFromType(argument, templateBindings));
    }
    for (const member of templateDeclaration.members) {
      if (member.kind === "struct" && (member as StructDecl).name)
        out.structs.set((member as StructDecl).name, member as StructDecl);
      else if (member.kind === "typedef_decl" && !out.types.has((member as any).name))
        out.types.set((member as any).name, (member as any).type);
    }
    // Static constexpr members (supportScalarVotes, maxVotes, ...). Without these a method body that sizes a
    for (const memberCandidate of templateDeclaration.members) {
      if (memberCandidate.kind !== "variable") continue;
      const variableDeclaration = memberCandidate as VariableDecl;
      if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer && !out.values.has(variableDeclaration.name)) {
        try {
          out.values.set(variableDeclaration.name, this.evalConstBig(variableDeclaration.initializer, out));
        } catch {
          /* a const that can't be evaluated under these bindings is simply omitted */
        }
      }
    }
    return out;
  }

  // Evaluate the container's static constexpr members (e.g. _nEncodedFlags = L>32?32:L) under bindings.
  staticConstsOf(name: string, templateBindings: TemplateBindings): Map<string, bigint> {
    const out = new Map<string, bigint>();
    const templateDeclaration = this.templates.get(name);
    if (!templateDeclaration) return out;
    for (const member of templateDeclaration.members) {
      if (member.kind === "variable") {
        const variableDeclaration = member as VariableDecl;
        if ((variableDeclaration.isStatic || variableDeclaration.isConstexpr) && variableDeclaration.initializer) out.set(variableDeclaration.name, this.evalConstBig(variableDeclaration.initializer, templateBindings));
      }
    }
    return out;
  }

  evalConstNum(expression: Expression, templateBindings: TemplateBindings): number {
    return Number(this.evalConstBig(expression, templateBindings));
  }

  private methodOwnerNames(name: string, seen = new Set<string>()): string[] {
    const bare =
      name.includes("::") && !this.globalStructs.has(name)
        ? name.slice(name.lastIndexOf("::") + 2)
        : name;
    if (seen.has(bare)) return [];
    seen.add(bare);
    const out = [bare];
    const struct = this.globalStructs.get(bare) ?? this.nested.get(bare);
    for (const base of struct?.bases ?? []) {
      const resolved = this.resolveType(base, EMPTY_TEMPLATE_BINDINGS);
      const baseName =
        resolved.kind === "name"
          ? resolved.name
          : resolved.kind === "template_instance"
            ? resolved.name
            : null;
      if (baseName) out.push(...this.methodOwnerNames(baseName, seen));
    }
    return out;
  }

  hasInstanceMethod(name: string, methodName: string): boolean {
    return this.methodOwnerNames(name).some((owner) => {
      const methods = this.templateMethods.get(owner);
      return (
        methods?.has(methodName) ||
        [...(methods?.keys() ?? [])].some((key) => key.startsWith(`${methodName}/`))
      );
    });
  }

  // Public: resolve a container/struct method to its body + the binding for the matched template instance, HONORING PARTIAL
  methodTemplate(
    name: string,
    callArguments: TypeSpec[],
    methodName: string,
    argCount?: number,
    paramTypeKey?: string,
  ): { def: FunctionTemplateDecl; bind: TemplateBindings; memberTemplate?: boolean } | null {
    // bindContainer carries the full method-scope binding (params + nested typedefs like VoteStorageType + static constexprs); instantiateTemplate's binding omits
    const bind = this.bindContainer(name, callArguments);
    const inst = this.instantiateTemplate(name, callArguments, EMPTY_TEMPLATE_BINDINGS);
    if (inst) {
      // Overload selection by arity (DateAndTime::isValid() vs the static isValid(y,m,d,...)): prefer an exact parameter-count match, then one whose extra
      const cands = inst.templateDeclaration.members.filter(
        (mm) =>
          (mm.kind === "function" || mm.kind === "function_template") &&
          (mm as FunctionDecl | FunctionTemplateDecl).name === methodName &&
          (mm as FunctionDecl | FunctionTemplateDecl).body,
      ) as Array<FunctionDecl | FunctionTemplateDecl>;
      const paramsOf = (candidate: FunctionDecl | FunctionTemplateDecl) =>
        candidate.kind === "function_template" ? (candidate.functionParameters ?? []) : candidate.params;
      let candidate: FunctionDecl | FunctionTemplateDecl | undefined = cands[0];
      if (argCount !== undefined && cands.length > 1) {
        candidate =
          cands.find((candidate) => paramsOf(candidate).length === argCount) ??
          cands.find(
            (candidate) =>
              paramsOf(candidate).length > argCount &&
              paramsOf(candidate)
                .slice(argCount)
                .every((parameter) => parameter.defaultValue !== undefined),
          ) ??
          cands[0];
      }
      if (candidate) {
        const fn = candidate;
        const def: FunctionTemplateDecl =
          fn.kind === "function_template"
            ? fn
            : {
                kind: "function_template",
                name: fn.name,
                params: inst.templateDeclaration.params,
                functionParameters: fn.params,
                returnType: fn.returnType,
                body: fn.body,
                isConstexpr: fn.isConstexpr,
                span: fn.span,
              };
        this.namespaceContexts.set(def, this.namespaceContextOf(fn));
        return {
          def,
          bind,
          memberTemplate: fn.kind === "function_template",
        };
      }
    }
    const specializationKey =
      argCount !== undefined && callArguments[0]
        ? `${methodName}/${argCount}@${this.typeKey(this.resolveType(callArguments[0], bind))}`
        : undefined;
    const overloadKey =
      argCount !== undefined && paramTypeKey
        ? `${methodName}/${argCount}@${paramTypeKey}`
        : undefined;
    let def: FunctionTemplateDecl | undefined;
    for (const owner of this.methodOwnerNames(name)) {
      const byName = this.templateMethods.get(owner);
      def =
        (overloadKey ? byName?.get(overloadKey) : undefined) ??
        (specializationKey ? byName?.get(specializationKey) : undefined) ??
        (argCount !== undefined ? byName?.get(`${methodName}/${argCount}`) : undefined) ??
        byName?.get(methodName);
      if (def) break;
    }
    if (!def?.body) return null;

    // Out-of-class definitions do not repeat default arguments. Preserve defaults from the authoritative
    // class declaration so a source-compiled call such as needsCleanup() still passes its declared 50%.
    const declared = inst?.templateDeclaration.members.find(
      (member): member is FunctionDecl =>
        member.kind === "function" &&
        member.name === methodName &&
        member.params.length === (def.functionParameters ?? []).length,
    );
    const memberTemplate = !this.templates.has(name) && def.params.length > 0;
    if (!declared) return { def, bind, memberTemplate };
    const mergedDef: FunctionTemplateDecl = {
      ...def,
      functionParameters: (def.functionParameters ?? []).map((param, index) => ({
        ...param,
        defaultValue: param.defaultValue ?? declared.params[index]?.defaultValue,
      })),
    };
    this.namespaceContexts.set(mergedDef, this.namespaceContextOf(def));
    return {
      def: mergedDef,
      bind,
      memberTemplate,
    };
  }

  // The hash-container's internal byte offsets, read from the PARSED qpi.h template layout (so they track the real field
  private hashContainerOffsets(
    name: string,
    callArguments: TypeSpec[],
    templateBindings: TemplateBindings,
    capacity: number,
  ): { elemSize: number; occBase: number; popOff: number; totalSize: number } | null {
    if (!this.templates.has(name) || !capacity) return null;
    const lt = this.layoutOfTemplate(name, callArguments, templateBindings);
    const el = lt.fields.get("_elements") ?? lt.fields.get("_keys"); // HashMap: _elements; HashSet: _keys
    const occ = lt.fields.get("_occupationFlags");
    const pop = lt.fields.get("_population");
    if (!el || !occ || !pop) return null;
    return {
      elemSize: Math.floor(el.size / capacity),
      occBase: occ.offset,
      popOff: pop.offset,
      totalSize: lt.size,
    };
  }

  // Concrete offsets/sizes for HashMap<K,V,L>. Key/value sizing follows standard C struct layout of
  hashmapInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
    if (callArguments.length < 3) return null;
    const keySize = this.sizeOfType(callArguments[0], templateBindings);
    const valSize = this.sizeOfType(callArguments[1], templateBindings);
    const capacity = Number(this.evalConstFromType(callArguments[2], templateBindings));
    if (!capacity || keySize <= 0 || valSize <= 0) return null;
    const elemAlign = Math.max(this.alignOfType(callArguments[0], templateBindings), this.alignOfType(callArguments[1], templateBindings));
    const valOff = this.alignUp(keySize, this.alignOfType(callArguments[1], templateBindings));

    const parsed = this.hashContainerOffsets("HashMap", callArguments, templateBindings, capacity);
    const elemSize = parsed?.elemSize ?? this.alignUp(valOff + valSize, elemAlign);
    const occBase = parsed?.occBase ?? elemSize * capacity;
    const popOff = parsed?.popOff ?? occBase + Math.floor((capacity * 2 + 63) / 64) * 8;
    const totalSize = parsed?.totalSize ?? popOff + 16;
    const hashMode = keySize === 32 ? 0 : 1;
    return {
      kind: "HashMap",
      L: capacity,
      elemSize,
      keySize,
      valOff,
      valSize,
      occBase,
      popOff,
      totalSize,
      hashMode,
    };
  }

  // HashSet<K,L>: keys-only — same probing/occupancy as HashMap with a zero-width value.
  hashsetInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
    if (callArguments.length < 2) return null;
    const keySize = this.sizeOfType(callArguments[0], templateBindings);
    const capacity = Number(this.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity || keySize <= 0) return null;

    const parsed = this.hashContainerOffsets("HashSet", callArguments, templateBindings, capacity);
    const elemSize = parsed?.elemSize ?? this.alignUp(keySize, this.alignOfType(callArguments[0], templateBindings));
    const occBase = parsed?.occBase ?? elemSize * capacity;
    const popOff = parsed?.popOff ?? occBase + Math.floor((capacity * 2 + 63) / 64) * 8;
    const totalSize = parsed?.totalSize ?? popOff + 16;
    const hashMode = keySize === 32 ? 0 : 1;
    return {
      kind: "HashMap",
      L: capacity,
      elemSize,
      keySize,
      valOff: 0,
      valSize: 0,
      occBase,
      popOff,
      totalSize,
      hashMode,
    };
  }

  arrayInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
    if (callArguments.length < 2) return null;
    const elemSize = this.sizeOfType(callArguments[0], templateBindings);
    const capacity = Number(this.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity || elemSize <= 0) return null;
    return { kind: "Array", L: capacity, elemSize, elemType: callArguments[0] };
  }

  // Backing-store geometry for Collection<T, L>.element(i) = _elements[i & (L-1)].value — all offsets read from the parsed layout (the
  collectionInfo(
    callArguments: TypeSpec[],
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
  ): {
    L: number;
    elementsOff: number;
    stride: number;
    valueOff: number;
    elemType: TypeSpec;
  } | null {
    if (callArguments.length < 2) return null;
    const capacity = Number(this.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity) return null;
    const elementsF = this.containerLayout("Collection", callArguments, templateBindings).fields.get("_elements");
    const bind = this.bindContainer("Collection", callArguments, templateBindings);
    const elemLayout = this.layoutOfType({ kind: "name", name: "Element" }, bind);
    const valueF = elemLayout?.fields.get("value");
    if (!elementsF || !elemLayout || !valueF) return null;
    return {
      L: capacity,
      elementsOff: elementsF.offset,
      stride: elemLayout.size,
      valueOff: valueF.offset,
      elemType: callArguments[0],
    };
  }

  // Backing-store geometry for LinkedList<T, L>.element(i) = _nodes[i & (L-1)].value — offsets from the parsed layout (the Node record
  linkedListInfo(
    callArguments: TypeSpec[],
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
  ): { L: number; nodesOff: number; stride: number; valueOff: number; elemType: TypeSpec } | null {
    if (callArguments.length < 2) return null;
    const capacity = Number(this.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity) return null;
    const nodesF = this.containerLayout("LinkedList", callArguments, templateBindings).fields.get("_nodes");
    const bind = this.bindContainer("LinkedList", callArguments, templateBindings);
    const nodeLayout = this.layoutOfType({ kind: "name", name: "Node" }, bind);
    const valueF = nodeLayout?.fields.get("value");
    if (!nodesF || !nodeLayout || !valueF) return null;
    return {
      L: capacity,
      nodesOff: nodesF.offset,
      stride: nodeLayout.size,
      valueOff: valueF.offset,
      elemType: callArguments[0],
    };
  }

  warn(message: string, at: number | Span): void {
    if (
      (globalThis as any).process?.env?.QINIT_WARN_TRACE &&
      message.includes((globalThis as any).process.env.QINIT_WARN_TRACE)
    ) {
      console.error(new Error(`TRACE: ${message}`).stack);
    }
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    this.warnings.push({ message, line, column });
  }

  // Hard semantic errors (not fidelity warnings): these abort the build regardless of strict mode. Deduplicated because speculative emission
  error(message: string, at: number | Span): void {
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    if (this.errors.some((error) => error.message === message && error.line === line && error.column === column)) {
      return;
    }

    this.errors.push({ message, line, column });
  }
}
