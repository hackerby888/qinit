import { emitFunction, emitHelperFunction } from "./statement-emitter";
import { SYSPROC_IO } from "./tables";
import { CodeGenerationContext } from "./code-generation-context";
import { ClassTemplate, CalleeIdl, CompiledHelperMetadata, NamespaceLookupContext } from "./types";
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
} from "../ast";
import type { Sema } from "../sema";
import {
  emitModule,
  type UserEntry,
  type SystemProcedureInfo,
  type ModuleSpecification,
  type QpiContextLayout,
} from "../framework";
import type { LhostAbiSpec } from "../lhost";
import { registerCallSig } from "../wat-ir";
import type { LiteAbiSource } from "@qinit/core/lite-abi-source";

// ---- entry point ----

export interface LibrarySymbolIndex {
  templates: Map<string, ClassTemplate>;
  specializations: Map<string, { specArgs: TypeSpec[]; templateDeclaration: ClassTemplate }[]>;
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
  entries: Array<{
    name: string;
    inputType: number;
    kind: number;
    inSize: number;
    outSize: number;
  }>;
  sysprocMask: number;
  lhostAbi?: LhostAbiSpec;
}

function registerLibraryMetadata(codeGenerationContext: CodeGenerationContext, libraryTypes: LibrarySymbolIndex): LhostAbiSpec {
  if (libraryTypes.liteAbi) codeGenerationContext.assetEnumerationRecord = libraryTypes.liteAbi.records.LiteAssetEntry;
  for (const [k, v] of libraryTypes.templates) codeGenerationContext.templates.set(k, v);
  for (const [k, v] of libraryTypes.specializations) codeGenerationContext.specializations.set(k, [...v]);
  for (const [k, v] of libraryTypes.libFns) codeGenerationContext.libFns.set(k, v);
  for (const [k, v] of libraryTypes.libFnOverloads) codeGenerationContext.libFnOverloads.set(k, [...v]);
  for (const [k, v] of libraryTypes.libFnTemplates) codeGenerationContext.libFnTemplates.set(k, v);
  for (const [k, v] of libraryTypes.globalStructs) codeGenerationContext.globalStructs.set(k, v);
  for (const [k, v] of libraryTypes.typedefs) codeGenerationContext.typedefs.set(k, v);
  for (const [k, v] of libraryTypes.constexprInit) codeGenerationContext.constexprInit.set(k, v);
  for (const [k, v] of libraryTypes.constexprType) codeGenerationContext.constexprType.set(k, v);
  for (const [k, v] of libraryTypes.enumConst) codeGenerationContext.enumConst.set(k, v);
  for (const [k, v] of libraryTypes.enumSize) codeGenerationContext.enumSize.set(k, v);
  for (const [k, v] of libraryTypes.enumUnderlying) codeGenerationContext.enumUnderlying.set(k, v);
  for (const [k, v] of libraryTypes.enumConstType) codeGenerationContext.enumConstType.set(k, v);
  for (const enumName of libraryTypes.enumNames) codeGenerationContext.enumNames.add(enumName);
  for (const [k, v] of libraryTypes.templateMethods) codeGenerationContext.templateMethods.set(k, new Map(v));
  for (const [scope, namespaces] of libraryTypes.namespaceUsings)
    codeGenerationContext.namespaceUsings.set(scope, [...namespaces]);
  for (const [declaration, context] of libraryTypes.namespaceContexts)
    codeGenerationContext.namespaceContexts.set(declaration, context);
  const lhostAbi: Record<
    string,
    { params: readonly ("i32" | "i64")[]; results: readonly ("i32" | "i64")[] }
  > = {};
  for (const [name, fn] of libraryTypes.importedFunctions) {
    const params = fn.params.map((param) => {
      const declared = codeGenerationContext.derefType(param.type);
      const isAddr =
        param.type.kind === "reference" ||
        param.type.kind === "pointer" ||
        codeGenerationContext.isAggregateType(declared);
      const width = isAddr ? 4 : codeGenerationContext.sizeOfType(declared);
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
    const returnType = codeGenerationContext.derefType(fn.returnType);
    const returnAggregate = !codeGenerationContext.isVoidType(returnType) && codeGenerationContext.isAggregateType(returnType);
    if (returnAggregate)
      throw new Error(
        `imported function '${name}' has an aggregate return; declare its hidden output address explicitly`,
      );
    const returnWidth = codeGenerationContext.isVoidType(returnType) ? 0 : codeGenerationContext.sizeOfType(returnType);
    if (
      returnWidth !== 0 &&
      returnWidth !== 1 &&
      returnWidth !== 2 &&
      returnWidth !== 4 &&
      returnWidth !== 8
    ) {
      throw new Error(`unsupported imported return '${name}' width ${returnWidth}`);
    }
    const helper: CompiledHelperMetadata = {
      label: `$lh_${name.slice("__lhost_".length)}`,
      params,
      retIsValue: returnWidth !== 0,
      retWasmType: returnWidth === 0 ? undefined : returnWidth < 8 ? "i32" : "i64",
      retType: returnType,
    };
    codeGenerationContext.helpers.set(name, helper);
    const importName = name.slice("__lhost_".length);
    const abiParams = params.map((param) => param.wasmType);
    const results = helper.retWasmType ? [helper.retWasmType] : [];
    lhostAbi[importName] = { params: abiParams, results };
    registerCallSig(helper.label, { params: abiParams, res: helper.retWasmType ?? "void" });
  }
  for (const row of libraryTypes.liteAbi?.lhost ?? []) {
    const derived = lhostAbi[row.name];
    if (
      !derived ||
      derived.params.join(",") !== row.params.join(",") ||
      derived.results.join(",") !== row.results.join(",")
    ) {
      throw new Error(
        `LH_IMPORT declaration for '${row.name}' does not match canonical core ABI metadata`,
      );
    }
  }
  return lhostAbi;
}

function contextLayoutFromCodegen(codeGenerationContext: CodeGenerationContext): QpiContextLayout {
  const context = codeGenerationContext.globalStructs.get("QpiContext");
  if (!context) throw new Error("qpi.h is missing QpiContext");
  const bufferSize = codeGenerationContext.constexprInit.get("__qinit_qpi_context_buffer_size");
  if (!bufferSize)
    throw new Error("assembled core headers are missing the Wasm QpiContext buffer capacity");
  const layout = codeGenerationContext.layoutOf(context);
  const offset = (name: string): number => {
    const field = layout.fields.get(name);
    if (!field) throw new Error(`QpiContext is missing field '${name}'`);
    return field.offset;
  };
  return {
    size: codeGenerationContext.evalConst(bufferSize),
    contractIndex: offset("_currentContractIndex"),
    originator: offset("_originator"),
    invocator: offset("_invocator"),
    invocationReward: offset("_invocationReward"),
  };
}

export function deriveQpiContextLayout(libraryTypes: LibrarySymbolIndex): QpiContextLayout {
  const codeGenerationContext = new CodeGenerationContext({} as Sema);
  registerLibraryMetadata(codeGenerationContext, libraryTypes);
  return contextLayoutFromCodegen(codeGenerationContext);
}

// Parse-once: collect the qpi.h library type table (templates/structs/typedefs/constants/methods).
export function indexLibraryDeclarations(
  declarations: Declaration[],
  inheritedNamespaceUsings?: Map<string, string[]>,
): LibrarySymbolIndex {
  const codeGenerationContext = new CodeGenerationContext({} as Sema);
  if (inheritedNamespaceUsings) {
    for (const [scope, namespaces] of inheritedNamespaceUsings)
      codeGenerationContext.namespaceUsings.set(scope, [...namespaces]);
  }
  codeGenerationContext.registerTopLevelDeclarations(declarations);
  const importedFunctions = new Map<string, FunctionDecl>();
  const collectHostImportDeclarations = (items: Declaration[]): void => {
    for (const declaration of items) {
      if (declaration.kind === "extern_block" || declaration.kind === "namespace") {
        collectHostImportDeclarations((declaration as any).body);
      } else if (
        declaration.kind === "function" &&
        declaration.name.startsWith("__lhost_") &&
        !declaration.body
      ) {
        importedFunctions.set(declaration.name, declaration);
      }
    }
  };
  collectHostImportDeclarations(declarations);
  return {
    templates: codeGenerationContext.templates,
    specializations: codeGenerationContext.specializations,
    libFns: codeGenerationContext.libFns,
    libFnOverloads: codeGenerationContext.libFnOverloads,
    libFnTemplates: codeGenerationContext.libFnTemplates,
    globalStructs: codeGenerationContext.globalStructs,
    typedefs: codeGenerationContext.typedefs,
    constexprInit: codeGenerationContext.constexprInit,
    constexprType: codeGenerationContext.constexprType,
    enumConst: codeGenerationContext.enumConst,
    enumSize: codeGenerationContext.enumSize,
    enumUnderlying: codeGenerationContext.enumUnderlying,
    enumConstType: codeGenerationContext.enumConstType,
    enumNames: codeGenerationContext.enumNames,
    templateMethods: codeGenerationContext.templateMethods,
    namespaceUsings: codeGenerationContext.namespaceUsings,
    namespaceContexts: codeGenerationContext.namespaceContexts,
    importedFunctions,
    liteAbi: undefined,
  };
}

export function generateWasmModule(
  translationUnit: { declarations: Declaration[] },
  sema: Sema,
  contractName: string,
  slot: number,
  arenaSz: number = 1024 * 1024 * 1024,
  lib?: LibrarySymbolIndex,
  callees?: CalleeIdl[],
  calleeStructs?: Map<string, StructDecl>,
  calleeTus?: Array<{ contractName: string; declarations: Declaration[] }>,
  memBase?: number,
  metadataOut?: GeneratedContractMetadata,
  gtestMode = false,
): string {
  const codeGenerationContext = new CodeGenerationContext(sema);
  codeGenerationContext.gtestMode = gtestMode;
  for (const itemItem of callees ?? []) codeGenerationContext.callees.set(itemItem.name, itemItem);
  // Callee struct layouts, keyed by their qualified name (`QX::Fees_output`), so a caller reading a callee's output type —
  if (calleeStructs) for (const [k, v] of calleeStructs) codeGenerationContext.globalStructs.set(k, v);

  // Register qpi.h library declarations (templates / structs / typedefs) once, then add the user contract's declarations.
  const lhostAbi = lib ? registerLibraryMetadata(codeGenerationContext, lib) : undefined;
  const systemProcedureImpl = new Map<string, number>();
  const systemProcedurePrefix = new Map<string, string>();
  for (const procedure of lib?.liteAbi?.systemProcedures ?? []) {
    const implementation = `__impl_${procedure.method}`;
    systemProcedureImpl.set(implementation, procedure.id);
    systemProcedurePrefix.set(implementation, procedure.name);
  }
  const contextLayout = contextLayoutFromCodegen(codeGenerationContext);
  codeGenerationContext.registerTopLevelDeclarations(translationUnit.declarations);
  for (const ct of calleeTus ?? [])
    codeGenerationContext.registerCalleeContractDeclarations(ct.contractName, ct.declarations);

  const contract = findContractStruct(translationUnit);
  if (!contract) {
    return emitModule({
      stateSize: 0,
      arenaSize: arenaSz,
      contextLayout,
      entries: [],
      sysprocs: [],
      userFunctionsWat: ";; no contract struct found",
      memBase,
      lhostAbi,
      assetEnumerationRecord: codeGenerationContext.assetEnumerationRecord,
    });
  }

  codeGenerationContext.collectNested(contract);
  codeGenerationContext.slot = slot;
  for (const member of contract.members) {
    if (member.kind === "function")
      codeGenerationContext.memberFnLine.set((member as FunctionDecl).name, (member as FunctionDecl).span?.line ?? 0);
  }

  // state size from StateData
  const stateData = codeGenerationContext["nested"].get("StateData");
  const stateLayout = stateData ? codeGenerationContext.layoutOf(stateData) : { size: 0, align: 1, fields: new Map() };
  const stateSize = stateLayout.size;
  codeGenerationContext.contractStateLayout = stateLayout;

  // registrations → entries
  const extractedRegs = extractRegistrations(contract, codeGenerationContext);
  for (const reg of extractedRegs) {
    if (!reg.constant) {
      codeGenerationContext.error(
        `registration input type for '${reg.fnName}' must be an integral constant expression`,
        reg.line,
      );
    } else if (reg.inputType < 1 || reg.inputType > 65535) {
      codeGenerationContext.error(
        `registration input type for '${reg.fnName}' must be in the range 1..65535`,
        reg.line,
      );
    }
  }
  const regs = extractedRegs.filter((extractedReg) => extractedReg.constant && extractedReg.inputType >= 1 && extractedReg.inputType <= 65535);
  const entries: UserEntry[] = [];
  const userFns: string[] = [];

  // A duplicate input type within a kind makes dispatch ambiguous (first registration would silently win) — reject.
  const seenReg = new Map<string, string>();
  for (const regCandidate of regs) {
    const key = `${regCandidate.kind}:${regCandidate.inputType}`;
    const prev = seenReg.get(key);
    if (prev) {
      codeGenerationContext.error(
        `${regCandidate.kind === 0 ? "function" : "procedure"} input type ${regCandidate.inputType} is registered twice ('${prev}' and '${regCandidate.fnName}')`,
        0,
      );
    }
    seenReg.set(key, regCandidate.fnName);
  }

  // Collect helper + private functions BEFORE emitting entries, so entry bodies can call them.
  const entryNames = new Set(regs.map((reg) => reg.fnName));
  const helperFns: { fn: FunctionDecl; info: CompiledHelperMetadata }[] = [];
  const privateFns: FunctionDecl[] = [];
  for (const memberCandidate of contract.members) {
    if (memberCandidate.kind !== "function") continue;
    const fn = memberCandidate as FunctionDecl;
    if (!fn.body) continue;
    if (entryNames.has(fn.name) || systemProcedureImpl.has(fn.name) || fn.name === "__impl_migrate")
      continue;
    if (
      fn.name === "__registerUserFunctionsAndProcedures" ||
      fn.name.includes("operator") ||
      fn.name === contract.name
    )
      continue;

    if (fn.params[0]?.name === "qpi") {
      const localsStruct = codeGenerationContext["nested"].get(`${fn.name}_locals`);
      codeGenerationContext.privates.set(fn.name, {
        label: `$priv_${fn.name}`,
        localsSize: localsStruct ? codeGenerationContext.layoutOf(localsStruct).size : 0,
      });
      privateFns.push(fn);
    } else {
      // Overloaded helpers each get their own wasm function; the call site ranks the overload set by argument signature
      const params = fn.params.map((parameter) => {
        // A NON-const scalar reference (an out-param like `uint64& revenue`) must be passed by address so the write reaches
        const isConstRef = parameter.type.kind === "reference" && parameter.type.referentType?.kind === "const";
        const isPtrRef = (parameter.type.kind === "reference" && !isConstRef) || parameter.type.kind === "pointer";
        const isAddr = isPtrRef || codeGenerationContext.isAggregateType(parameter.type);
        // A BY-VALUE aggregate param rides the by-address ABI but owns a private copy: the callee may mutate it
        const byValAgg = isAddr && parameter.type.kind !== "reference" && parameter.type.kind !== "pointer";
        return {
          name: parameter.name,
          wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64",
          isAddr,
          type: codeGenerationContext.derefType(parameter.type),
          byValAgg,
        };
      });
      const isVoid = codeGenerationContext.isVoidType(fn.returnType); // `void` may parse as {kind:"void"} OR {kind:"name","void"}
      // size the referent for a `const T&` return — sizeOfType on the reference itself is pointer-width
      const retAgg =
        !isVoid && codeGenerationContext.isAggregateType(fn.returnType)
          ? codeGenerationContext.sizeOfType(codeGenerationContext.derefType(fn.returnType))
          : undefined;
      const retIsValue = !isVoid && !retAgg;
      const set = codeGenerationContext.helperOverloads.get(fn.name) ?? [];
      const label = set.length === 0 ? `$h_${fn.name}` : `$h_${fn.name}__ov${set.length}`;
      const lookup = codeGenerationContext.namespaceContextOf(fn);
      const info: CompiledHelperMetadata = {
        label,
        params,
        retIsValue,
        retAgg,
        retType: isVoid ? undefined : codeGenerationContext.derefType(fn.returnType),
        sourceNamespace: lookup.sourceNamespace,
        usingNamespaces: lookup.usingNamespaces,
      };
      set.push(info);
      codeGenerationContext.helperOverloads.set(fn.name, set);
      if (set.length === 1) {
        codeGenerationContext.helpers.set(fn.name, info);
      }
      helperFns.push({ fn, info });
    }
  }

  // Resolve a named I/O / locals struct to its layout, following typedefs and nested structs: a contract may
  const emptyL = () => ({ size: 0, align: 1, fields: new Map() });
  const resolveIO = (name: string) => {
    const structDeclaration = codeGenerationContext["nested"].get(name);
    if (structDeclaration) return codeGenerationContext.layoutOf(structDeclaration);
    const lt = codeGenerationContext.layoutOfType({ kind: "name", name });
    if (lt) return lt;
    const byteSize = codeGenerationContext.sizeOfType({ kind: "name", name });
    return byteSize > 0 ? { size: byteSize, align: Math.min(byteSize, 8), fields: new Map() } : emptyL();
  };

  const hasIOType = (name: string) =>
    codeGenerationContext["nested"].has(name) || codeGenerationContext.typedefs.has(name) || codeGenerationContext.globalStructs.has(name);
  for (const reg of regs) {
    const fn = findMemberFn(contract, reg.fnName);
    if (!fn?.body) {
      codeGenerationContext.error(
        `registered ${reg.kind === 0 ? "function" : "procedure"} '${reg.fnName}' has no implementation body`,
        reg.line,
      );
      continue;
    }
    const contextType = codeGenerationContext.derefType(fn.params[0]?.type ?? { kind: "void" });
    const actualKind =
      contextType.kind === "name" && contextType.name === "QpiContextFunctionCall"
        ? 0
        : contextType.kind === "name" && contextType.name === "QpiContextProcedureCall"
          ? 1
          : -1;
    if (actualKind >= 0 && actualKind !== reg.kind) {
      codeGenerationContext.error(
        `'${reg.fnName}' is a ${actualKind === 0 ? "function" : "procedure"} but is registered as a ${reg.kind === 0 ? "function" : "procedure"}`,
        reg.line,
      );
    }

    const inName = `${reg.fnName}_input`;
    const outName = `${reg.fnName}_output`;
    const localsName = `${reg.fnName}_locals`;
    if (!hasIOType(inName))
      codeGenerationContext.error(`entry '${reg.fnName}' is missing required type '${inName}'`, reg.line);
    if (!hasIOType(outName))
      codeGenerationContext.error(`entry '${reg.fnName}' is missing required type '${outName}'`, reg.line);

    const inSize = resolveIO(inName).size;
    const outSize = resolveIO(outName).size;
    const localsSize = resolveIO(localsName).size;
    if (reg.kind === 1 && inSize > 1024)
      codeGenerationContext.error(`${inName} exceeds MAX_INPUT_SIZE (1024 bytes)`, reg.line);
    if (outSize > 65535)
      codeGenerationContext.error(`${outName} is too large; maximum output size is 65535 bytes`, reg.line);
    if (localsSize > 32768)
      codeGenerationContext.error(`${localsName} exceeds MAX_SIZE_OF_CONTRACT_LOCALS (32768 bytes)`, reg.line);
  }

  // Pre-pass: register every REGISTER_USER_* name -> {label, localsSize} before any body is emitted, so a CALL() to a
  for (let regIndex = 0; regIndex < regs.length; regIndex++) {
    codeGenerationContext.registered.set(regs[regIndex].fnName, {
      label: `$user_${regIndex}`,
      localsSize: resolveIO(`${regs[regIndex].fnName}_locals`).size,
    });
  }

  for (let regIndexInner = 0; regIndexInner < regs.length; regIndexInner++) {
    const reg = regs[regIndexInner];
    const fn = findMemberFn(contract, reg.fnName);
    const inLayout = resolveIO(`${reg.fnName}_input`);
    const outLayout = resolveIO(`${reg.fnName}_output`);
    const localsLayout = resolveIO(`${reg.fnName}_locals`);

    const label = `$user_${regIndexInner}`;
    userFns.push(emitFunction(codeGenerationContext, label, fn, stateLayout, inLayout, outLayout, localsLayout));

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
    const lt = codeGenerationContext.layoutOfType({ kind: "name", name });
    if (lt) return lt;
    const byteSize = codeGenerationContext.sizeOfType({ kind: "name", name });
    return byteSize > 0 ? { size: byteSize, align: Math.min(byteSize, 8), fields: new Map() } : empty;
  };

  // system procedures. Lifecycle procedures take no input/output but CAN declare locals (the
  const sysprocs: SystemProcedureInfo[] = [];
  let sysIdx = 0;
  for (const memberCandidate of contract.members) {
    if (memberCandidate.kind === "function") {
      const fn = memberCandidate as FunctionDecl;
      const spId = systemProcedureImpl.get(fn.name);
      if (spId !== undefined) {
        const label = `$sys_${sysIdx++}`;
        const localsLayout = layoutFor(`${systemProcedurePrefix.get(fn.name) ?? fn.name}_locals`);
        const io = SYSPROC_IO[fn.name];
        const inLayout = layoutOfNamed(io?.in);
        const outLayout = layoutOfNamed(io?.out);
        // typedIO hooks: bind input/output to their typedef targets so container methods (Array.get) and bare scalar output assignment resolve
        let aliases:
          | Map<
              string,
              { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }
            >
          | undefined;
        if (io?.typedIO) {
          aliases = new Map();
          const bindIO = (pname: string, ioName: string | undefined, slot: string) => {
            if (!ioName) return;
            const type = codeGenerationContext.typedefs.get(ioName) ?? ({ kind: "name", name: ioName } as TypeSpec);
            aliases!.set(pname, { wasmType: "i32", isAddr: true, local: slot, type: type });
          };
          bindIO("input", io.in, "__qinit_in");
          bindIO("output", io.out, "__qinit_out");
        }
        userFns.push(
          emitFunction(codeGenerationContext, label, fn, stateLayout, inLayout, outLayout, localsLayout, aliases),
        );
        sysprocs.push({
          id: spId,
          localsSize: localsLayout.size,
          inSize: inLayout.size,
          outSize: outLayout.size,
          label,
        });
      }
    }
  }

  // MIGRATE() — __impl_migrate(qpi, state, const OldStateData& oldState, MIGRATE_locals& locals) rides the entry ABI with the old-state blob in
  let migrate: ModuleSpecification["migrate"];
  const migrateFn = findMemberFn(contract, "__impl_migrate");
  if (migrateFn?.body) {
    const oldLayout = resolveIO("OldStateData");
    const localsLayout = resolveIO("MIGRATE_locals");
    const aliases = new Map([
      [
        "oldState",
        {
          wasmType: "i32" as const,
          isAddr: true,
          local: "__qinit_in",
          type: { kind: "name", name: "OldStateData" } as TypeSpec,
        },
      ],
    ]);
    userFns.push(
      emitFunction(codeGenerationContext, "$migrate", migrateFn, stateLayout, oldLayout, empty, localsLayout, aliases),
    );
    migrate = { label: "$migrate", oldStateSize: oldLayout.size, localsSize: localsLayout.size };
  }

  // PRIVATE_ functions share the entry (context, state, input, output, locals) shape — emit them with emitFunction.
  for (const fn of privateFns) {
    const info = codeGenerationContext.privates.get(fn.name)!;
    userFns.push(
      emitFunction(
        codeGenerationContext,
        info.label,
        fn,
        stateLayout,
        layoutFor(`${fn.name}_input`),
        layoutFor(`${fn.name}_output`),
        layoutFor(`${fn.name}_locals`),
      ),
    );
  }
  for (const { fn, info } of helperFns) {
    userFns.push(emitHelperFunction(codeGenerationContext, info, fn, stateLayout));
  }

  // Instantiated container methods compiled from the real qpi.h bodies (accumulated while lowering the function bodies above). Appended last;
  userFns.push(...codeGenerationContext.emittedMethodOrder);

  const spec: ModuleSpecification = {
    stateSize,
    arenaSize: arenaSz,
    contextLayout,
    entries,
    sysprocs,
    userFunctionsWat: userFns.join("\n"),
    migrate,
    memBase,
    gtest: gtestMode,
    capabilities: [...codeGenerationContext.capabilities],
    lhostAbi,
    assetEnumerationRecord: codeGenerationContext.assetEnumerationRecord,
  };

  if (metadataOut) {
    metadataOut.stateSize = stateSize;
    metadataOut.entries = regs.map((reg, regIndex) => ({
      name: reg.fnName,
      inputType: reg.inputType,
      kind: reg.kind,
      inSize: entries[regIndex]?.inSize ?? 0,
      outSize: entries[regIndex]?.outSize ?? 0,
    }));
    metadataOut.sysprocMask = sysprocs.reduce((mask, proc) => mask | (1 << proc.id), 0);
    metadataOut.lhostAbi = lhostAbi;
  }

  // expose warnings + hard errors via a side channel (sema diagnostics)
  for (const warning of codeGenerationContext.warnings) {
    sema.warn(warning.message, { start: 0, end: 0, line: warning.line, column: warning.column }, "fidelity");
  }
  for (const er of codeGenerationContext.errors) {
    sema.error(er.message, { start: 0, end: 0, line: er.line, column: er.column });
  }

  return emitModule(spec);
}

// ---- AST helpers ----

export function findContractStruct(translationUnit: { declarations: Declaration[] }): StructDecl | null {
  // The user contract may end up nested inside a namespace if qpi.h's bracket structure recovered imperfectly, so search
  const all: StructDecl[] = [];
  const walk = (declarations: Declaration[]) => {
    for (const declaration of declarations) {
      if (declaration.kind === "struct") all.push(declaration as StructDecl);
      else if (declaration.kind === "namespace") walk((declaration as any).body);
    }
  };
  walk(translationUnit.declarations);

  for (const allItem of all) {
    if (allItem.bases.some((baseType) => baseType.kind === "name" && baseType.name === "ContractBase")) return allItem;
    if (allItem.name === "CONTRACT_STATE_TYPE") return allItem;
  }
  // fallback: a struct with a nested StateData that isn't one of the qpi.h library types
  for (const allItemCandidate of all) {
    if (allItemCandidate.members.some((member) => member.kind === "struct" && (member as StructDecl).name === "StateData"))
      return allItemCandidate;
  }
  return null;
}

export interface ContractRegistration {
  fnName: string;
  kind: number;
  inputType: number;
  constant: boolean;
  line: number;
}

function evalRegistrationConstant(expression: Expression | undefined, codeGenerationContext: CodeGenerationContext): bigint | null {
  if (!expression) return null;
  switch (expression.kind) {
    case "int_literal":
      try {
        return lexRegistrationLiteral(expression.value);
      } catch {
        return null;
      }
    case "bool_literal":
      return expression.value ? 1n : 0n;
    case "char_literal":
      return BigInt(expression.value);
    case "identifier":
      return codeGenerationContext.resolveConst(expression.name);
    case "qualified_name":
      return codeGenerationContext.resolveConst(`${expression.namespace}::${expression.name}`);
    case "paren":
      return evalRegistrationConstant(expression.expression, codeGenerationContext);
    case "unary_op": {
      const numericValue = evalRegistrationConstant(expression.argument, codeGenerationContext);
      if (numericValue === null) return null;
      if (expression.operator === "-") return -numericValue;
      if (expression.operator === "+") return numericValue;
      if (expression.operator === "~") return ~numericValue;
      if (expression.operator === "!") return numericValue === 0n ? 1n : 0n;
      return null;
    }
    case "binary_op": {
      const leftValue = evalRegistrationConstant(expression.left, codeGenerationContext);
      const rightValue = evalRegistrationConstant(expression.right, codeGenerationContext);
      if (leftValue === null || rightValue === null) return null;
      switch (expression.operator) {
        case "+":
          return leftValue + rightValue;
        case "-":
          return leftValue - rightValue;
        case "*":
          return leftValue * rightValue;
        case "/":
          return rightValue === 0n ? null : leftValue / rightValue;
        case "%":
          return rightValue === 0n ? null : leftValue % rightValue;
        case "<<":
          return leftValue << rightValue;
        case ">>":
          return leftValue >> rightValue;
        case "&":
          return leftValue & rightValue;
        case "|":
          return leftValue | rightValue;
        case "^":
          return leftValue ^ rightValue;
        case "==":
          return leftValue === rightValue ? 1n : 0n;
        case "!=":
          return leftValue !== rightValue ? 1n : 0n;
        case "<":
          return leftValue < rightValue ? 1n : 0n;
        case ">":
          return leftValue > rightValue ? 1n : 0n;
        case "<=":
          return leftValue <= rightValue ? 1n : 0n;
        case ">=":
          return leftValue >= rightValue ? 1n : 0n;
        default:
          return null;
      }
    }
    case "ternary": {
      const numericValue = evalRegistrationConstant(expression.condition, codeGenerationContext);
      return numericValue === null ? null : evalRegistrationConstant(numericValue !== 0n ? expression.then : expression.else_, codeGenerationContext);
    }
    case "c_cast":
    case "static_cast":
      return evalRegistrationConstant(expression.expression, codeGenerationContext);
    default:
      return null;
  }
}

function lexRegistrationLiteral(value: string): bigint {
  const cleaned = value.replace(/[uUlL]+$/, "").replace(/'/g, "");
  if (/^0[0-7]+$/.test(cleaned)) return BigInt(`0o${cleaned.slice(1)}`);
  return BigInt(cleaned);
}

export function extractRegistrations(contract: StructDecl, codeGenerationContext: CodeGenerationContext): ContractRegistration[] {
  const regs: ContractRegistration[] = [];
  const regFn = contract.members.find(
    (member) =>
      member.kind === "function" && (member as FunctionDecl).name === "__registerUserFunctionsAndProcedures",
  ) as FunctionDecl | undefined;

  if (!regFn?.body || regFn.body.kind !== "compound") return regs;

  for (const statement of regFn.body.body) {
    if (statement.kind !== "expression") continue;
    const expression = statement.expression;
    if (expression.kind !== "call") continue;
    if (expression.callee.kind !== "member_access") continue;
    const method = expression.callee.member;
    const isFn = method === "__registerUserFunction";
    const isProc = method === "__registerUserProcedure";
    const isNotif = method === "__registerUserProcedureNotification";
    if (!isFn && !isProc && !isNotif) continue;

    // args: (void*)fnName, inputType, sizeof(...), ...
    const fnArg = expression.callArguments[0];
    let fnName = "";
    if (fnArg?.kind === "c_cast" && fnArg.expression.kind === "identifier") fnName = fnArg.expression.name;
    else if (fnArg?.kind === "identifier") fnName = fnArg.name;

    const itArg = expression.callArguments[1];
    const evaluated = evalRegistrationConstant(itArg, codeGenerationContext);
    let inputType = evaluated === null ? 0 : Number(evaluated);

    // Notification procedure (oracle reply callback): its id arg is the synthetic __id_<proc> ((CONTRACT_INDEX << 22) | defLine, qpi.h
    if (isNotif && fnName) {
      const def = contract.members.find(
        (member) => member.kind === "function" && (member as FunctionDecl).name === fnName,
      ) as FunctionDecl | undefined;
      inputType = (def?.span?.line ?? 0) & 0xffff;
    }

    if (fnName) {
      regs.push({
        fnName,
        kind: isFn ? 0 : 1,
        inputType,
        constant: isNotif || evaluated !== null,
        line: expression.span.line,
      });
    }
  }

  return regs;
}

export function findMemberFn(contract: StructDecl, name: string): FunctionDecl | null {
  for (const member of contract.members) {
    if (member.kind === "function" && (member as FunctionDecl).name === name) return member as FunctionDecl;
  }
  return null;
}
