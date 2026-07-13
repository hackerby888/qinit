import { emitFunction, emitHelperFunction } from "./stmt";
import { SYSPROC_IO } from "./tables";
import { Codegen } from "./cg";
import { ClassTemplate, CalleeIdl, HelperInfo, NamespaceLookupContext } from "./types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";
import type { Sema } from "../sema";
import { emitModule, type UserEntry, type SysProcInfo, type ModuleSpec, type QpiContextLayout } from "../framework";
import type { LhostAbiSpec } from "../lhost";
import { registerCallSig } from "../ir";
import type { LiteAbiSource } from "@qinit/core/lite-abi-source";

// ---- entry point ----

export interface LibTypes {
  templates: Map<string, ClassTemplate>;
  specializations: Map<string, { specArgs: TypeSpec[]; tmpl: ClassTemplate }[]>;
  libFns: Map<string, FunctionDecl>;
  libFnOverloads: Map<string, FunctionDecl[]>;
  libFnTemplates: Map<string, FunctionTemplateDecl[]>;
  globalStructs: Map<string, StructDecl>;
  typedefs: Map<string, TypeSpec>;
  constexprInit: Map<string, Expression>;
  constexprType: Map<string, TypeSpec>;
  enumConst: Map<string, bigint>;
  enumSize: Map<string, number>;
  enumUnderlying: Map<string, TypeSpec>;
  enumConstType: Map<string, TypeSpec>;
  enumNames: Set<string>;
  templateMethods: Map<string, Map<string, FunctionTemplateDecl>>;
  namespaceUsings: Map<string, string[]>;
  namespaceContexts: Map<object, NamespaceLookupContext>;
  importedFunctions: Map<string, FunctionDecl>;
  liteAbi?: LiteAbiSource;
}

export interface GeneratedContractMetadata {
  stateSize: number;
  entries: Array<{ name: string; inputType: number; kind: number; inSize: number; outSize: number }>;
  sysprocMask: number;
  lhostAbi?: LhostAbiSpec;
}

function seedLibTypes(cg: Codegen, lib: LibTypes): LhostAbiSpec {
  if (lib.liteAbi) cg.assetEnumerationRecord = lib.liteAbi.records.LiteAssetEntry;
  for (const [k, v] of lib.templates) cg.templates.set(k, v);
  for (const [k, v] of lib.specializations) cg.specializations.set(k, [...v]);
  for (const [k, v] of lib.libFns) cg.libFns.set(k, v);
  for (const [k, v] of lib.libFnOverloads) cg.libFnOverloads.set(k, [...v]);
  for (const [k, v] of lib.libFnTemplates) cg.libFnTemplates.set(k, v);
  for (const [k, v] of lib.globalStructs) cg.globalStructs.set(k, v);
  for (const [k, v] of lib.typedefs) cg.typedefs.set(k, v);
  for (const [k, v] of lib.constexprInit) cg.constexprInit.set(k, v);
  for (const [k, v] of lib.constexprType) cg.constexprType.set(k, v);
  for (const [k, v] of lib.enumConst) cg.enumConst.set(k, v);
  for (const [k, v] of lib.enumSize) cg.enumSize.set(k, v);
  for (const [k, v] of lib.enumUnderlying) cg.enumUnderlying.set(k, v);
  for (const [k, v] of lib.enumConstType) cg.enumConstType.set(k, v);
  for (const n of lib.enumNames) cg.enumNames.add(n);
  for (const [k, v] of lib.templateMethods) cg.templateMethods.set(k, new Map(v));
  for (const [scope, namespaces] of lib.namespaceUsings) cg.namespaceUsings.set(scope, [...namespaces]);
  for (const [declaration, context] of lib.namespaceContexts) cg.namespaceContexts.set(declaration, context);
  const lhostAbi: Record<string, { params: readonly ("i32" | "i64")[]; results: readonly ("i32" | "i64")[] }> = {};
  for (const [name, fn] of lib.importedFunctions) {
    const params = fn.params.map((param) => {
      const declared = cg.derefType(param.type);
      const isAddr = param.type.kind === "reference" || param.type.kind === "pointer" || cg.isAggregateType(declared);
      const width = isAddr ? 4 : cg.sizeOfType(declared);
      if (!isAddr && width !== 1 && width !== 2 && width !== 4 && width !== 8) {
        throw new Error(`unsupported imported parameter '${name}.${param.name}' width ${width}`);
      }
      return {
        name: param.name,
        wasmType: (isAddr || width < 8 ? "i32" : "i64") as "i32" | "i64",
        isAddr,
        type: declared,
      };
    });
    const returnType = cg.derefType(fn.returnType);
    const returnAggregate = !cg.isVoidType(returnType) && cg.isAggregateType(returnType);
    if (returnAggregate) throw new Error(`imported function '${name}' has an aggregate return; declare its hidden output address explicitly`);
    const returnWidth = cg.isVoidType(returnType) ? 0 : cg.sizeOfType(returnType);
    if (returnWidth !== 0 && returnWidth !== 1 && returnWidth !== 2 && returnWidth !== 4 && returnWidth !== 8) {
      throw new Error(`unsupported imported return '${name}' width ${returnWidth}`);
    }
    const helper: HelperInfo = {
      label: `$lh_${name.slice("__lhost_".length)}`,
      params,
      retIsValue: returnWidth !== 0,
      retWasmType: returnWidth === 0 ? undefined : returnWidth < 8 ? "i32" : "i64",
      retType: returnType,
    };
    cg.helpers.set(name, helper);
    const importName = name.slice("__lhost_".length);
    const abiParams = params.map((param) => param.wasmType);
    const results = helper.retWasmType ? [helper.retWasmType] : [];
    lhostAbi[importName] = { params: abiParams, results };
    registerCallSig(helper.label, { params: abiParams, res: helper.retWasmType ?? "void" });
  }
  for (const row of lib.liteAbi?.lhost ?? []) {
    const derived = lhostAbi[row.name];
    if (!derived || derived.params.join(",") !== row.params.join(",") || derived.results.join(",") !== row.results.join(",")) {
      throw new Error(`LH_IMPORT declaration for '${row.name}' does not match canonical core ABI metadata`);
    }
  }
  return lhostAbi;
}

function contextLayoutFromCodegen(cg: Codegen): QpiContextLayout {
  const context = cg.globalStructs.get("QpiContext");
  if (!context) throw new Error("qpi.h is missing QpiContext");
  const bufferSize = cg.constexprInit.get("__qinit_qpi_context_buffer_size");
  if (!bufferSize) throw new Error("assembled core headers are missing the Wasm QpiContext buffer capacity");
  const layout = cg.layoutOf(context);
  const offset = (name: string): number => {
    const field = layout.fields.get(name);
    if (!field) throw new Error(`QpiContext is missing field '${name}'`);
    return field.offset;
  };
  return {
    size: cg.evalConst(bufferSize),
    contractIndex: offset("_currentContractIndex"),
    originator: offset("_originator"),
    invocator: offset("_invocator"),
    invocationReward: offset("_invocationReward"),
  };
}

export function deriveQpiContextLayout(lib: LibTypes): QpiContextLayout {
  const cg = new Codegen({} as Sema);
  seedLibTypes(cg, lib);
  return contextLayoutFromCodegen(cg);
}

// Parse-once: collect the qpi.h library type table (templates/structs/typedefs/constants/methods).
export function buildLibTypes(decls: Declaration[], inheritedNamespaceUsings?: Map<string, string[]>): LibTypes {
  const cg = new Codegen({} as Sema);
  if (inheritedNamespaceUsings) {
    for (const [scope, namespaces] of inheritedNamespaceUsings) cg.namespaceUsings.set(scope, [...namespaces]);
  }
  cg.collectTU(decls);
  const importedFunctions = new Map<string, FunctionDecl>();
  const collectImports = (items: Declaration[]): void => {
    for (const declaration of items) {
      if (declaration.kind === "extern_block" || declaration.kind === "namespace") {
        collectImports((declaration as any).body);
      } else if (declaration.kind === "function" && declaration.name.startsWith("__lhost_") && !declaration.body) {
        importedFunctions.set(declaration.name, declaration);
      }
    }
  };
  collectImports(decls);
  return {
    templates: cg.templates,
    specializations: cg.specializations,
    libFns: cg.libFns,
    libFnOverloads: cg.libFnOverloads,
    libFnTemplates: cg.libFnTemplates,
    globalStructs: cg.globalStructs,
    typedefs: cg.typedefs,
    constexprInit: cg.constexprInit,
    constexprType: cg.constexprType,
    enumConst: cg.enumConst,
    enumSize: cg.enumSize,
    enumUnderlying: cg.enumUnderlying,
    enumConstType: cg.enumConstType,
    enumNames: cg.enumNames,
    templateMethods: cg.templateMethods,
    namespaceUsings: cg.namespaceUsings,
    namespaceContexts: cg.namespaceContexts,
    importedFunctions,
    liteAbi: undefined,
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
  metadataOut?: GeneratedContractMetadata,
  gtestMode = false,
): string {
  const cg = new Codegen(sema);
  cg.gtestMode = gtestMode;
  for (const c of callees ?? []) cg.callees.set(c.name, c);
  // Callee struct layouts, keyed by their qualified name (`QX::Fees_output`), so a caller reading a callee's output type —
  if (calleeStructs) for (const [k, v] of calleeStructs) cg.globalStructs.set(k, v);

  // Seed the qpi.h library type table (templates / structs / typedefs) parsed once, then add the user contract's
  const lhostAbi = lib ? seedLibTypes(cg, lib) : undefined;
  const systemProcedureImpl = new Map<string, number>();
  const systemProcedurePrefix = new Map<string, string>();
  for (const procedure of lib?.liteAbi?.systemProcedures ?? []) {
    const implementation = `__impl_${procedure.method}`;
    systemProcedureImpl.set(implementation, procedure.id);
    systemProcedurePrefix.set(implementation, procedure.name);
  }
  const contextLayout = contextLayoutFromCodegen(cg);
  cg.collectTU(tu.declarations);
  for (const ct of calleeTus ?? []) cg.seedCallee(ct.name, ct.decls);

  const contract = findContractStruct(tu);
  if (!contract) {
    return emitModule({ stateSize: 0, arenaSize: arenaSz, contextLayout, entries: [], sysprocs: [], userFunctionsWat: ";; no contract struct found", memBase, lhostAbi, assetEnumerationRecord: cg.assetEnumerationRecord });
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
  const extractedRegs = extractRegistrations(contract, cg);
  for (const reg of extractedRegs) {
    if (!reg.constant) {
      cg.error(`registration input type for '${reg.fnName}' must be an integral constant expression`, reg.line);
    } else if (reg.inputType < 1 || reg.inputType > 65535) {
      cg.error(`registration input type for '${reg.fnName}' must be in the range 1..65535`, reg.line);
    }
  }
  const regs = extractedRegs.filter((r) => r.constant && r.inputType >= 1 && r.inputType <= 65535);
  const entries: UserEntry[] = [];
  const userFns: string[] = [];

  // A duplicate input type within a kind makes dispatch ambiguous (first registration would silently win) — reject.
  const seenReg = new Map<string, string>();
  for (const r of regs) {
    const key = `${r.kind}:${r.inputType}`;
    const prev = seenReg.get(key);
    if (prev) {
      cg.error(`${r.kind === 0 ? "function" : "procedure"} input type ${r.inputType} is registered twice ('${prev}' and '${r.fnName}')`, 0);
    }
    seenReg.set(key, r.fnName);
  }

  // Collect helper + private functions BEFORE emitting entries, so entry bodies can call them.
  const entryNames = new Set(regs.map((r) => r.fnName));
  const helperFns: { fn: FunctionDecl; info: HelperInfo }[] = [];
  const privateFns: FunctionDecl[] = [];
  for (const m of contract.members) {
    if (m.kind !== "function") continue;
    const fn = m as FunctionDecl;
    if (!fn.body) continue;
    if (entryNames.has(fn.name) || systemProcedureImpl.has(fn.name) || fn.name === "__impl_migrate") continue;
    if (fn.name === "__registerUserFunctionsAndProcedures" || fn.name.includes("operator") || fn.name === contract.name) continue;

    if (fn.params[0]?.name === "qpi") {
      const localsStruct = cg["nested"].get(`${fn.name}_locals`);
      cg.privates.set(fn.name, { label: `$priv_${fn.name}`, localsSize: localsStruct ? cg.layoutOf(localsStruct).size : 0 });
      privateFns.push(fn);
    } else {
      // Overloaded helpers each get their own wasm function; the call site ranks the overload set by argument signature
      const params = fn.params.map((p) => {
        // A NON-const scalar reference (an out-param like `uint64& revenue`) must be passed by address so the write reaches
        const isConstRef = p.type.kind === "reference" && p.type.refereed?.kind === "const";
        const isPtrRef = (p.type.kind === "reference" && !isConstRef) || p.type.kind === "pointer";
        const isAddr = isPtrRef || cg.isAggregateType(p.type);
        // A BY-VALUE aggregate param rides the by-address ABI but owns a private copy: the callee may mutate it
        const byValAgg = isAddr && p.type.kind !== "reference" && p.type.kind !== "pointer";
        return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: cg.derefType(p.type), byValAgg };
      });
      const isVoid = cg.isVoidType(fn.returnType);   // `void` may parse as {kind:"void"} OR {kind:"name","void"}
      // size the referent for a `const T&` return — sizeOfType on the reference itself is pointer-width
      const retAgg = !isVoid && cg.isAggregateType(fn.returnType) ? cg.sizeOfType(cg.derefType(fn.returnType)) : undefined;
      const retIsValue = !isVoid && !retAgg;
      const set = cg.helperOverloads.get(fn.name) ?? [];
      const label = set.length === 0 ? `$h_${fn.name}` : `$h_${fn.name}__ov${set.length}`;
      const lookup = cg.namespaceContextOf(fn);
      const info: HelperInfo = {
        label, params, retIsValue, retAgg, retType: isVoid ? undefined : cg.derefType(fn.returnType),
        sourceNamespace: lookup.sourceNamespace, usingNamespaces: lookup.usingNamespaces,
      };
      set.push(info);
      cg.helperOverloads.set(fn.name, set);
      if (set.length === 1) {
        cg.helpers.set(fn.name, info);
      }
      helperFns.push({ fn, info });
    }
  }

  // Resolve a named I/O / locals struct to its layout, following typedefs and nested structs: a contract may
  const emptyL = () => ({ size: 0, align: 1, fields: new Map() });
  const resolveIO = (name: string) => {
    const s = cg["nested"].get(name);
    if (s) return cg.layoutOf(s);
    const lt = cg.layoutOfType({ kind: "name", name });
    if (lt) return lt;
    const sz = cg.sizeOfType({ kind: "name", name });
    return sz > 0 ? { size: sz, align: Math.min(sz, 8), fields: new Map() } : emptyL();
  };

  const hasIOType = (name: string) => cg["nested"].has(name) || cg.typedefs.has(name) || cg.globalStructs.has(name);
  for (const reg of regs) {
    const fn = findMemberFn(contract, reg.fnName);
    if (!fn?.body) {
      cg.error(`registered ${reg.kind === 0 ? "function" : "procedure"} '${reg.fnName}' has no implementation body`, reg.line);
      continue;
    }
    const contextType = cg.derefType(fn.params[0]?.type ?? { kind: "void" });
    const actualKind = contextType.kind === "name" && contextType.name === "QpiContextFunctionCall" ? 0
      : contextType.kind === "name" && contextType.name === "QpiContextProcedureCall" ? 1
      : -1;
    if (actualKind >= 0 && actualKind !== reg.kind) {
      cg.error(`'${reg.fnName}' is a ${actualKind === 0 ? "function" : "procedure"} but is registered as a ${reg.kind === 0 ? "function" : "procedure"}`, reg.line);
    }

    const inName = `${reg.fnName}_input`;
    const outName = `${reg.fnName}_output`;
    const localsName = `${reg.fnName}_locals`;
    if (!hasIOType(inName)) cg.error(`entry '${reg.fnName}' is missing required type '${inName}'`, reg.line);
    if (!hasIOType(outName)) cg.error(`entry '${reg.fnName}' is missing required type '${outName}'`, reg.line);

    const inSize = resolveIO(inName).size;
    const outSize = resolveIO(outName).size;
    const localsSize = resolveIO(localsName).size;
    if (reg.kind === 1 && inSize > 1024) cg.error(`${inName} exceeds MAX_INPUT_SIZE (1024 bytes)`, reg.line);
    if (outSize > 65535) cg.error(`${outName} is too large; maximum output size is 65535 bytes`, reg.line);
    if (localsSize > 32768) cg.error(`${localsName} exceeds MAX_SIZE_OF_CONTRACT_LOCALS (32768 bytes)`, reg.line);
  }

  // Pre-pass: register every REGISTER_USER_* name -> {label, localsSize} before any body is emitted, so a CALL() to a
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
    const lt = cg.layoutOfType({ kind: "name", name });
    if (lt) return lt;
    const sz = cg.sizeOfType({ kind: "name", name });
    return sz > 0 ? { size: sz, align: Math.min(sz, 8), fields: new Map() } : empty;
  };

  // system procedures. Lifecycle procedures take no input/output but CAN declare locals (the
  const sysprocs: SysProcInfo[] = [];
  let sysIdx = 0;
  for (const m of contract.members) {
    if (m.kind === "function") {
      const fn = m as FunctionDecl;
      const spId = systemProcedureImpl.get(fn.name);
      if (spId !== undefined) {
        const label = `$sys_${sysIdx++}`;
        const localsLayout = layoutFor(`${systemProcedurePrefix.get(fn.name) ?? fn.name}_locals`);
        const io = SYSPROC_IO[fn.name];
        const inLayout = layoutOfNamed(io?.in);
        const outLayout = layoutOfNamed(io?.out);
        // typedIO hooks: bind input/output to their typedef targets so container methods (Array.get) and bare scalar output assignment resolve
        let aliases: Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }> | undefined;
        if (io?.typedIO) {
          aliases = new Map();
          const bindIO = (pname: string, ioName: string | undefined, slot: string) => {
            if (!ioName) return;
            const t = cg.typedefs.get(ioName) ?? { kind: "name", name: ioName } as TypeSpec;
            aliases!.set(pname, { wasmType: "i32", isAddr: true, local: slot, type: t });
          };
          bindIO("input", io.in, "__qinit_in");
          bindIO("output", io.out, "__qinit_out");
        }
        userFns.push(emitFunction(cg, label, fn, stateLayout, inLayout, outLayout, localsLayout, aliases));
        sysprocs.push({ id: spId, localsSize: localsLayout.size, inSize: inLayout.size, outSize: outLayout.size, label });
      }
    }
  }

  // MIGRATE() — __impl_migrate(qpi, state, const OldStateData& oldState, MIGRATE_locals& locals) rides the entry ABI with the old-state blob in
  let migrate: ModuleSpec["migrate"];
  const migrateFn = findMemberFn(contract, "__impl_migrate");
  if (migrateFn?.body) {
    const oldLayout = resolveIO("OldStateData");
    const localsLayout = resolveIO("MIGRATE_locals");
    const aliases = new Map([["oldState", {
      wasmType: "i32" as const, isAddr: true, local: "__qinit_in",
      type: { kind: "name", name: "OldStateData" } as TypeSpec,
    }]]);
    userFns.push(emitFunction(cg, "$migrate", migrateFn, stateLayout, oldLayout, empty, localsLayout, aliases));
    migrate = { label: "$migrate", oldStateSize: oldLayout.size, localsSize: localsLayout.size };
  }

  // PRIVATE_ functions share the entry (ctx,state,in,out,locals) shape — emit them with emitFunction.
  for (const fn of privateFns) {
    const info = cg.privates.get(fn.name)!;
    userFns.push(emitFunction(cg, info.label, fn, stateLayout, layoutFor(`${fn.name}_input`), layoutFor(`${fn.name}_output`), layoutFor(`${fn.name}_locals`)));
  }
  for (const { fn, info } of helperFns) {
    userFns.push(emitHelperFunction(cg, info, fn, stateLayout));
  }

  // Instantiated container methods compiled from the real qpi.h bodies (accumulated while lowering the function bodies above). Appended last;
  userFns.push(...cg.emittedMethodOrder);

  const spec: ModuleSpec = {
    stateSize,
    arenaSize: arenaSz,
    contextLayout,
    entries,
    sysprocs,
    userFunctionsWat: userFns.join("\n"),
    migrate,
    memBase,
    gtest: gtestMode,
    capabilities: [...cg.capabilities],
    lhostAbi,
    assetEnumerationRecord: cg.assetEnumerationRecord,
  };

  if (metadataOut) {
    metadataOut.stateSize = stateSize;
    metadataOut.entries = regs.map((reg, i) => ({
      name: reg.fnName,
      inputType: reg.inputType,
      kind: reg.kind,
      inSize: entries[i]?.inSize ?? 0,
      outSize: entries[i]?.outSize ?? 0,
    }));
    metadataOut.sysprocMask = sysprocs.reduce((mask, proc) => mask | (1 << proc.id), 0);
    metadataOut.lhostAbi = lhostAbi;
  }

  // expose warnings + hard errors via a side channel (sema diagnostics)
  for (const w of cg.warnings) {
    sema.warn(w.message, { start: 0, end: 0, line: w.line, col: w.col }, "fidelity");
  }
  for (const er of cg.errors) {
    sema.error(er.message, { start: 0, end: 0, line: er.line, col: er.col });
  }

  return emitModule(spec);
}

// ---- AST helpers ----

export function findContractStruct(tu: { declarations: Declaration[] }): StructDecl | null {
  // The user contract may end up nested inside a namespace if qpi.h's bracket structure recovered imperfectly, so search
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

export interface RegEntry {
  fnName: string;
  kind: number;
  inputType: number;
  constant: boolean;
  line: number;
}

function evalRegistrationConstant(expr: Expression | undefined, cg: Codegen): bigint | null {
  if (!expr) return null;
  switch (expr.kind) {
    case "int_literal":
      try { return lexRegistrationLiteral(expr.value); } catch { return null; }
    case "bool_literal": return expr.value ? 1n : 0n;
    case "char_literal": return BigInt(expr.value);
    case "identifier": return cg.resolveConst(expr.name);
    case "qualified_name": return cg.resolveConst(`${expr.namespace}::${expr.name}`);
    case "paren": return evalRegistrationConstant(expr.expr, cg);
    case "unary_op": {
      const a = evalRegistrationConstant(expr.arg, cg);
      if (a === null) return null;
      if (expr.op === "-") return -a;
      if (expr.op === "+") return a;
      if (expr.op === "~") return ~a;
      if (expr.op === "!") return a === 0n ? 1n : 0n;
      return null;
    }
    case "binary_op": {
      const l = evalRegistrationConstant(expr.left, cg);
      const r = evalRegistrationConstant(expr.right, cg);
      if (l === null || r === null) return null;
      switch (expr.op) {
        case "+": return l + r; case "-": return l - r; case "*": return l * r;
        case "/": return r === 0n ? null : l / r; case "%": return r === 0n ? null : l % r;
        case "<<": return l << r; case ">>": return l >> r;
        case "&": return l & r; case "|": return l | r; case "^": return l ^ r;
        case "==": return l === r ? 1n : 0n; case "!=": return l !== r ? 1n : 0n;
        case "<": return l < r ? 1n : 0n; case ">": return l > r ? 1n : 0n;
        case "<=": return l <= r ? 1n : 0n; case ">=": return l >= r ? 1n : 0n;
        default: return null;
      }
    }
    case "ternary": {
      const c = evalRegistrationConstant(expr.cond, cg);
      return c === null ? null : evalRegistrationConstant(c !== 0n ? expr.then : expr.else_, cg);
    }
    case "c_cast": case "static_cast": return evalRegistrationConstant(expr.expr, cg);
    default: return null;
  }
}

function lexRegistrationLiteral(value: string): bigint {
  const cleaned = value.replace(/[uUlL]+$/, "").replace(/'/g, "");
  if (/^0[0-7]+$/.test(cleaned)) return BigInt(`0o${cleaned.slice(1)}`);
  return BigInt(cleaned);
}

export function extractRegistrations(contract: StructDecl, cg: Codegen): RegEntry[] {
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
    const evaluated = evalRegistrationConstant(itArg, cg);
    let inputType = evaluated === null ? 0 : Number(evaluated);

    // Notification procedure (oracle reply callback): its id arg is the synthetic __id_<proc> ((CONTRACT_INDEX << 22) | defLine, qpi.h
    if (isNotif && fnName) {
      const def = contract.members.find((m) => m.kind === "function" && (m as FunctionDecl).name === fnName) as FunctionDecl | undefined;
      inputType = (def?.span?.line ?? 0) & 0xffff;
    }

    if (fnName) {
      regs.push({ fnName, kind: isFn ? 0 : 1, inputType, constant: isNotif || evaluated !== null, line: e.span.line });
    }
  }

  return regs;
}

export function findMemberFn(contract: StructDecl, name: string): FunctionDecl | null {
  for (const m of contract.members) {
    if (m.kind === "function" && (m as FunctionDecl).name === name) return m as FunctionDecl;
  }
  return null;
}
