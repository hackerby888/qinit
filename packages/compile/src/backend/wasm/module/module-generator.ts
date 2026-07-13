import { emitFunction, emitHelperFunction } from "../functions/function-emitter";
import { SYSPROC_IO } from "../abi/tables";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { CalleeIdl, CompiledHelperMetadata } from "../types";
import type { TypeSpec, Declaration, StructDecl, FunctionDecl } from "../../../ast";
import type { Sema } from "../../../sema";
import { emitModule, type UserEntry, type SystemProcedureInfo, type ModuleSpecification } from "../../../framework";
import { GeneratedContractMetadata, LibrarySymbolIndex, contextLayoutFromCodegen, registerLibraryMetadata } from "./library-index";
import { findContractStruct, findMemberFn } from "./contract-discovery";
import { extractRegistrations } from "./registrations";
export function generateWasmModule(translationUnit: {
    declarations: Declaration[];
}, sema: Sema, contractName: string, slot: number, arenaSz: number = 1024 * 1024 * 1024, lib?: LibrarySymbolIndex, callees?: CalleeIdl[], calleeStructs?: Map<string, StructDecl>, calleeTus?: Array<{
    contractName: string;
    declarations: Declaration[];
}>, memBase?: number, metadataOut?: GeneratedContractMetadata, gtestMode = false): string {
    const programAnalysis = new ProgramAnalysis(sema);
    programAnalysis.gtestMode = gtestMode;
    for (const calleeItem of callees ?? [])
        programAnalysis.callees.set(calleeItem.name, calleeItem);
    // Callee struct layouts, keyed by their qualified name (`QX::Fees_output`), so a caller reading a callee's output type —
    if (calleeStructs)
        for (const [structName, structDeclaration] of calleeStructs)
            programAnalysis.globalStructs.set(structName, structDeclaration);
    // Register qpi.h library declarations (templates / structs / typedefs) once, then add the user contract's declarations.
    const lhostAbi = lib ? registerLibraryMetadata(programAnalysis, lib) : undefined;
    const systemProcedureImpl = new Map<string, number>();
    const systemProcedurePrefix = new Map<string, string>();
    for (const procedure of lib?.liteAbi?.systemProcedures ?? []) {
        const implementation = `__impl_${procedure.method}`;
        systemProcedureImpl.set(implementation, procedure.id);
        systemProcedurePrefix.set(implementation, procedure.name);
    }
    const contextLayout = contextLayoutFromCodegen(programAnalysis);
    programAnalysis.registerTopLevelDeclarations(translationUnit.declarations);
    for (const ct of calleeTus ?? [])
        programAnalysis.registerCalleeContractDeclarations(ct.contractName, ct.declarations);
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
            assetEnumerationRecord: programAnalysis.assetEnumerationRecord,
        });
    }
    programAnalysis.collectNested(contract);
    programAnalysis.slot = slot;
    for (const member of contract.members) {
        if (member.kind === "function")
            programAnalysis.memberFnLine.set((member as FunctionDecl).name, (member as FunctionDecl).span?.line ?? 0);
    }
    // state size from StateData
    const stateData = programAnalysis["nested"].get("StateData");
    const stateLayout = stateData ? programAnalysis.layoutOf(stateData) : { size: 0, align: 1, fields: new Map() };
    const stateSize = stateLayout.size;
    programAnalysis.contractStateLayout = stateLayout;
    // registrations → entries
    const extractedRegs = extractRegistrations(contract, programAnalysis);
    for (const reg of extractedRegs) {
        if (!reg.constant) {
            programAnalysis.error(`registration input type for '${reg.fnName}' must be an integral constant expression`, reg.line);
        }
        else if (reg.inputType < 1 || reg.inputType > 65535) {
            programAnalysis.error(`registration input type for '${reg.fnName}' must be in the range 1..65535`, reg.line);
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
            programAnalysis.error(`${regCandidate.kind === 0 ? "function" : "procedure"} input type ${regCandidate.inputType} is registered twice ('${prev}' and '${regCandidate.fnName}')`, 0);
        }
        seenReg.set(key, regCandidate.fnName);
    }
    // Collect helper + private functions BEFORE emitting entries, so entry bodies can call them.
    const entryNames = new Set(regs.map((reg) => reg.fnName));
    const helperFns: {
        fn: FunctionDecl;
        info: CompiledHelperMetadata;
    }[] = [];
    const privateFns: FunctionDecl[] = [];
    for (const memberCandidate of contract.members) {
        if (memberCandidate.kind !== "function")
            continue;
        const fn = memberCandidate as FunctionDecl;
        if (!fn.body)
            continue;
        if (entryNames.has(fn.name) || systemProcedureImpl.has(fn.name) || fn.name === "__impl_migrate")
            continue;
        if (fn.name === "__registerUserFunctionsAndProcedures" ||
            fn.name.includes("operator") ||
            fn.name === contract.name)
            continue;
        if (fn.params[0]?.name === "qpi") {
            const localsStruct = programAnalysis["nested"].get(`${fn.name}_locals`);
            programAnalysis.privates.set(fn.name, {
                label: `$priv_${fn.name}`,
                localsSize: localsStruct ? programAnalysis.layoutOf(localsStruct).size : 0,
            });
            privateFns.push(fn);
        }
        else {
            // Overloaded helpers each get their own wasm function; the call site ranks the overload set by argument signature
            const params = fn.params.map((parameter) => {
                // A NON-const scalar reference (an out-param like `uint64& revenue`) must be passed by address so the write reaches
                const isConstRef = parameter.type.kind === "reference" && parameter.type.referentType?.kind === "const";
                const isPtrRef = (parameter.type.kind === "reference" && !isConstRef) || parameter.type.kind === "pointer";
                const isAddr = isPtrRef || programAnalysis.isAggregateType(parameter.type);
                // A BY-VALUE aggregate param rides the by-address ABI but owns a private copy: the callee may mutate it
                const byValAgg = isAddr && parameter.type.kind !== "reference" && parameter.type.kind !== "pointer";
                return {
                    name: parameter.name,
                    wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64",
                    isAddr,
                    type: programAnalysis.derefType(parameter.type),
                    byValAgg,
                };
            });
            const isVoid = programAnalysis.isVoidType(fn.returnType); // `void` may parse as {kind:"void"} OR {kind:"name","void"}
            // size the referent for a `const T&` return — sizeOfType on the reference itself is pointer-width
            const retAgg = !isVoid && programAnalysis.isAggregateType(fn.returnType)
                ? programAnalysis.sizeOfType(programAnalysis.derefType(fn.returnType))
                : undefined;
            const retIsValue = !isVoid && !retAgg;
            const set = programAnalysis.helperOverloads.get(fn.name) ?? [];
            const label = set.length === 0 ? `$h_${fn.name}` : `$h_${fn.name}__ov${set.length}`;
            const lookup = programAnalysis.namespaceContextOf(fn);
            const info: CompiledHelperMetadata = {
                label,
                params,
                retIsValue,
                retAgg,
                retType: isVoid ? undefined : programAnalysis.derefType(fn.returnType),
                sourceNamespace: lookup.sourceNamespace,
                usingNamespaces: lookup.usingNamespaces,
            };
            set.push(info);
            programAnalysis.helperOverloads.set(fn.name, set);
            if (set.length === 1) {
                programAnalysis.helpers.set(fn.name, info);
            }
            helperFns.push({ fn, info });
        }
    }
    // Resolve a named I/O / locals struct to its layout, following typedefs and nested structs: a contract may
    const emptyL = () => ({ size: 0, align: 1, fields: new Map() });
    const resolveIO = (name: string) => {
        const structDeclaration = programAnalysis["nested"].get(name);
        if (structDeclaration)
            return programAnalysis.layoutOf(structDeclaration);
        const lt = programAnalysis.layoutOfType({ kind: "name", name });
        if (lt)
            return lt;
        const byteSize = programAnalysis.sizeOfType({ kind: "name", name });
        return byteSize > 0 ? { size: byteSize, align: Math.min(byteSize, 8), fields: new Map() } : emptyL();
    };
    const hasIOType = (name: string) => programAnalysis["nested"].has(name) || programAnalysis.typedefs.has(name) || programAnalysis.globalStructs.has(name);
    for (const reg of regs) {
        const fn = findMemberFn(contract, reg.fnName);
        if (!fn?.body) {
            programAnalysis.error(`registered ${reg.kind === 0 ? "function" : "procedure"} '${reg.fnName}' has no implementation body`, reg.line);
            continue;
        }
        const contextType = programAnalysis.derefType(fn.params[0]?.type ?? { kind: "void" });
        const actualKind = contextType.kind === "name" && contextType.name === "QpiContextFunctionCall"
            ? 0
            : contextType.kind === "name" && contextType.name === "QpiContextProcedureCall"
                ? 1
                : -1;
        if (actualKind >= 0 && actualKind !== reg.kind) {
            programAnalysis.error(`'${reg.fnName}' is a ${actualKind === 0 ? "function" : "procedure"} but is registered as a ${reg.kind === 0 ? "function" : "procedure"}`, reg.line);
        }
        const inName = `${reg.fnName}_input`;
        const outName = `${reg.fnName}_output`;
        const localsName = `${reg.fnName}_locals`;
        if (!hasIOType(inName))
            programAnalysis.error(`entry '${reg.fnName}' is missing required type '${inName}'`, reg.line);
        if (!hasIOType(outName))
            programAnalysis.error(`entry '${reg.fnName}' is missing required type '${outName}'`, reg.line);
        const inSize = resolveIO(inName).size;
        const outSize = resolveIO(outName).size;
        const localsSize = resolveIO(localsName).size;
        if (reg.kind === 1 && inSize > 1024)
            programAnalysis.error(`${inName} exceeds MAX_INPUT_SIZE (1024 bytes)`, reg.line);
        if (outSize > 65535)
            programAnalysis.error(`${outName} is too large; maximum output size is 65535 bytes`, reg.line);
        if (localsSize > 32768)
            programAnalysis.error(`${localsName} exceeds MAX_SIZE_OF_CONTRACT_LOCALS (32768 bytes)`, reg.line);
    }
    // Pre-pass: register every REGISTER_USER_* name -> {label, localsSize} before any body is emitted, so a CALL() to a
    for (let regIndex = 0; regIndex < regs.length; regIndex++) {
        programAnalysis.registered.set(regs[regIndex].fnName, {
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
        userFns.push(emitFunction(programAnalysis, label, fn, stateLayout, inLayout, outLayout, localsLayout));
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
        if (!name)
            return empty;
        const lt = programAnalysis.layoutOfType({ kind: "name", name });
        if (lt)
            return lt;
        const byteSize = programAnalysis.sizeOfType({ kind: "name", name });
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
                let aliases: Map<string, {
                    wasmType: "i32" | "i64";
                    isAddr: boolean;
                    type: TypeSpec;
                    local?: string;
                }> | undefined;
                if (io?.typedIO) {
                    aliases = new Map();
                    const bindIO = (pname: string, ioName: string | undefined, slot: string) => {
                        if (!ioName)
                            return;
                        const type = programAnalysis.typedefs.get(ioName) ?? ({ kind: "name", name: ioName } as TypeSpec);
                        aliases!.set(pname, { wasmType: "i32", isAddr: true, local: slot, type: type });
                    };
                    bindIO("input", io.in, "__qinit_in");
                    bindIO("output", io.out, "__qinit_out");
                }
                userFns.push(emitFunction(programAnalysis, label, fn, stateLayout, inLayout, outLayout, localsLayout, aliases));
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
        userFns.push(emitFunction(programAnalysis, "$migrate", migrateFn, stateLayout, oldLayout, empty, localsLayout, aliases));
        migrate = { label: "$migrate", oldStateSize: oldLayout.size, localsSize: localsLayout.size };
    }
    // PRIVATE_ functions share the entry (context, state, input, output, locals) shape — emit them with emitFunction.
    for (const fn of privateFns) {
        const info = programAnalysis.privates.get(fn.name)!;
        userFns.push(emitFunction(programAnalysis, info.label, fn, stateLayout, layoutFor(`${fn.name}_input`), layoutFor(`${fn.name}_output`), layoutFor(`${fn.name}_locals`)));
    }
    for (const { fn, info } of helperFns) {
        userFns.push(emitHelperFunction(programAnalysis, info, fn, stateLayout));
    }
    // Instantiated container methods compiled from the real qpi.h bodies (accumulated while lowering the function bodies above). Appended last;
    userFns.push(...programAnalysis.emittedMethodOrder);
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
        capabilities: [...programAnalysis.capabilities],
        lhostAbi,
        assetEnumerationRecord: programAnalysis.assetEnumerationRecord,
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
    for (const warning of programAnalysis.warnings) {
        sema.warn(warning.message, { start: 0, end: 0, line: warning.line, column: warning.column }, "fidelity");
    }
    for (const er of programAnalysis.errors) {
        sema.error(er.message, { start: 0, end: 0, line: er.line, column: er.column });
    }
    return emitModule(spec);
}
