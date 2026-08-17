// buildCorpusRunner replaces core-lite's contract_testing.h with the engine-backed test harness.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContractWithClang, buildCorpusRunner, systemContracts, type DynCallees } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, loadQpiHeader, type ContractIdl } from "@qinit/compiler";
import { initK12 } from "@qinit/core";
import type { CompilerBackend } from "../config";

// System suites too memory- or dispatch-heavy for the routine developer gate — shared-memory, opt-in heavy
// suite. Empirical, not purely state-size: PULSE/QTF corpora retain state pointers; NOST has ~1 GiB state.
const HEAVY_SYSTEM_GTEST_NAMES = new Set(["PULSE", "QTF", "QTRY", "GGWP", "QEARN", "NOST"]);
const ARENA = 8 * 1024 * 1024;
const SHARED_START = 0x20000000;
const MAIN_ARENA = DEFAULT_COMPILE_ARENA_SIZE_BYTES;
const DEP_ARENA = 128 * 1024 * 1024;
const NOST_ARENA = 256 * 1024 * 1024;
const SLACK = 128 * 1024 * 1024;

const mainArenaSize = (name: string): number => (name === "NOST" ? NOST_ARENA : MAIN_ARENA);

export interface StdGtestContractSpec {
    contractPath: string;
    name: string;
    stateType: string;
    slot: number;
}

export interface StdGtestRun {
    runnerOk: boolean;
    buildError?: string;
    results: TestResult[];
    name: string;
    slot: number;
    heavy: boolean;
    backend: CompilerBackend;
    timings?: Record<string, number>;
}

export interface CorpusRun extends StdGtestRun {
    found: boolean;
    hasCorpus: boolean;
    available: string[];
}

export type SystemGtestTier = "light" | "heavy";

export interface SystemGtestCorpus {
    name: string;
    slot: number;
    stateType: string;
    contractPath: string;
    corpusPath: string;
    tier: SystemGtestTier;
}

export function systemGtestTier(name: string): SystemGtestTier {
    return HEAVY_SYSTEM_GTEST_NAMES.has(name.toUpperCase()) ? "heavy" : "light";
}

function corpusPathFor(core: string, name: string, file: string): string | undefined {
    return [join(core, "test", `contract_${name.toLowerCase()}.cpp`), join(core, "test", `contract_${file.replace(/\.h$/, "").toLowerCase()}.cpp`)].find(
        existsSync,
    );
}

// Discover from the live core checkout so a newly added or renamed system-contract corpus is picked up
// automatically instead of waiting for a second hard-coded Qinit list to be updated.
export function systemGtestCorpora(core: string): SystemGtestCorpus[] {
    return systemContracts(core).flatMap((contract) => {
        const corpusPath = corpusPathFor(core, contract.name, contract.file);
        if (!corpusPath) return [];
        return [
            {
                name: contract.name,
                slot: contract.index,
                stateType: contract.stateType,
                contractPath: join(core, "src", "contracts", contract.file),
                corpusPath,
                tier: systemGtestTier(contract.name),
            },
        ];
    });
}

// Keep offsets unsigned above 2 GiB. JavaScript bitwise operators coerce to
// signed i32 and would turn a valid imported-memory base negative.
const align64k = (x: number) => Math.ceil(x / 0x10000) * 0x10000;

// Read a contract wasm's exported state_size without wiring real host imports (stub every import to 0).
function stateSizeOf(wasm: Uint8Array): number {
    const mod = new WebAssembly.Module(wasm as unknown as BufferSource);
    const imports: Record<string, Record<string, unknown>> = {};
    for (const imp of WebAssembly.Module.imports(mod)) {
        if (imp.kind !== "function") continue;
        const results = (imp as { type?: { results?: string[] } }).type?.results ?? [];
        (imports[imp.module] ??= {})[imp.name] = results.includes("i64") ? () => 0n : () => 0;
    }
    const ex = new WebAssembly.Instance(mod, imports as WebAssembly.Imports).exports as {
        state_size(): number;
    };
    return ex.state_size() >>> 0;
}

// Sibling SYSTEM contracts referenced by the test or the contract source — built + deployed alongside the main.
function depSpecs(catalog: any[], mainName: string, testSrc: string, contractSrc: string, core: string): StdGtestContractSpec[] {
    const deps: StdGtestContractSpec[] = [];
    const seen = new Set<string>([mainName]);
    const visit = (source: string) => {
        for (const other of catalog) {
            if (seen.has(other.name)) continue;
            const re = new RegExp(`\\b(${other.name}|${other.stateType})(::|_[A-Z0-9])`);
            if (!re.test(source)) continue;
            seen.add(other.name);
            const contractPath = join(core, "src", "contracts", other.file);
            const dependencySource = readFileSync(contractPath, "utf8");
            // Push after visiting nested references so compile/deploy order gives a
            // dependency the IDLs of its own callees (PULSE -> QTF -> QRP -> RL).
            visit(dependencySource);
            deps.push({
                contractPath,
                name: other.name,
                stateType: other.stateType,
                slot: other.index,
            });
        }
    };
    visit(`${testSrc}\n${contractSrc}`);
    return deps;
}

async function clangWasms(
    core: string,
    scratch: string,
    main: StdGtestContractSpec,
    deps: readonly StdGtestContractSpec[],
    dynCallees: DynCallees,
    shared: boolean,
): Promise<Record<number, Uint8Array>> {
    const out: Record<number, Uint8Array> = {};
    let nextBase = SHARED_START;
    const build = async (s: StdGtestContractSpec, arenaSizeBytes: number, isMain: boolean, useShared: boolean): Promise<Uint8Array | null> => {
        const common = {
            contractPath: s.contractPath,
            contractName: s.name,
            stateType: s.stateType,
            slot: s.slot,
            corePath: core,
            skipVerify: true,
            dynCallees,
        };
        const p1 = await buildContractWithClang({
            ...common,
            outDir: join(scratch, "n_" + s.name),
            ...(useShared ? { arenaSizeBytes } : {}),
        });
        if (!p1.wasmPath) {
            if (isMain) throw new Error("clang build: " + (p1.stderr ?? "").split("\n").filter((l: string) => /error:/.test(l))[0]);
            return null;
        }
        if (!useShared) return new Uint8Array(readFileSync(p1.wasmPath));
        const base = nextBase;
        nextBase = align64k(base + stateSizeOf(new Uint8Array(readFileSync(p1.wasmPath))) + arenaSizeBytes + SLACK);
        const p2 = await buildContractWithClang({
            ...common,
            outDir: join(scratch, "ns_" + s.name),
            arenaSizeBytes,
            sharedMemoryBaseOffsetBytes: base,
        });
        return p2.wasmPath ? new Uint8Array(readFileSync(p2.wasmPath)) : null;
    };
    const m = await build(main, mainArenaSize(main.name), true, shared);
    if (m) out[main.slot] = m;
    for (const d of deps) {
        // NOST's state is already close to the Wasm32 address-space ceiling. Its QX dependency does not retain
        // runner-side state pointers, so keep that dependency in its own memory instead of exceeding 4 GiB.
        const w = await build(d, DEP_ARENA, false, shared && main.name !== "NOST");
        if (w) out[d.slot] = w;
    }
    return out;
}

async function typescriptWasms(
    headers: string,
    main: StdGtestContractSpec,
    deps: readonly StdGtestContractSpec[],
    shared: boolean,
    onPhase?: (label: string) => void,
): Promise<{ wasms: Record<number, Uint8Array>; timings?: Record<string, number> }> {
    const out: Record<number, Uint8Array> = {};
    const callees: ContractIdl[] = [];
    const calleeSources: any[] = [];
    let nextBase = SHARED_START;
    const emitAt = async (o: any, arenaSizeBytes: number): Promise<{ wasm: Uint8Array; timings?: Record<string, number> }> => {
        const oph = onPhase ? (p: string) => onPhase(`compiling ${o.contractName} (TypeScript) — ${p}`) : undefined;
        const requireWasm = (r: Awaited<ReturnType<typeof compileContractWithTypeScript>>, stage: string) => {
            if (r.wasm.byteLength) return r;
            const errors = r.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message);
            throw new Error(`${o.contractName} ${stage}: ${errors.join("; ") || "compiler returned empty wasm"}`);
        };
        if (!shared) {
            const r = requireWasm(
                await compileContractWithTypeScript({
                    ...o,
                    arenaSizeBytes: ARENA,
                    onPhase: oph,
                }),
                "build",
            );
            return { wasm: r.wasm, timings: r.timings };
        }
        const p1 = requireWasm(await compileContractWithTypeScript({ ...o, arenaSizeBytes: ARENA }), "state-size probe").wasm; // silent — arena-independent
        const base = nextBase;
        nextBase = align64k(base + stateSizeOf(p1) + arenaSizeBytes + SLACK);
        const r = requireWasm(
            await compileContractWithTypeScript({
                ...o,
                arenaSizeBytes,
                sharedMemoryBaseOffsetBytes: base,
                onPhase: oph,
            }),
            "shared-memory build",
        );
        return { wasm: r.wasm, timings: r.timings };
    };
    for (const d of deps) {
        const dsrc = readFileSync(d.contractPath, "utf8");
        // Compile dependencies in order so each sees earlier IDL and source context.
        const depOpts = {
            source: dsrc,
            contractName: d.stateType,
            slot: d.slot,
            qpiHeader: headers,
            callees: callees.length ? callees : undefined,
            calleeSources: calleeSources.length ? calleeSources : undefined,
        };
        const dr = await compileContractWithTypeScript({
            ...depOpts,
            arenaSizeBytes: ARENA,
        });
        if (!dr.wasm.byteLength) {
            const errors = dr.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message);
            throw new Error(`TypeScript dependency ${d.name}: ${errors.join("; ") || "compiler returned empty wasm"}`);
        }
        if (!dr.idl) {
            throw new Error(`TypeScript dependency ${d.name}: compiler did not produce IDL`);
        }
        out[d.slot] = shared && main.name !== "NOST" ? (await emitAt(depOpts, DEP_ARENA)).wasm : dr.wasm;
        callees.push({
            ...dr.idl,
            name: d.stateType,
            slot: d.slot,
        });
        calleeSources.push({
            name: d.stateType,
            slot: d.slot,
            source: dsrc,
        });
    }
    const csrc = readFileSync(main.contractPath, "utf8");
    const m = await emitAt(
        {
            source: csrc,
            contractName: main.stateType,
            slot: main.slot,
            qpiHeader: headers,
            callees: callees.length ? callees : undefined,
            calleeSources: calleeSources.length ? calleeSources : undefined,
        },
        mainArenaSize(main.name),
    );
    out[main.slot] = m.wasm;
    return { wasms: out, timings: m.timings };
}

// Build + run a standard contract_testing.h gtest for ANY contract (user or system).
export async function runStdGtest(opts: {
    contractPath: string;
    testPath: string;
    name: string;
    stateType: string;
    slot: number;
    core: string;
    backend: CompilerBackend;
    scratch: string;
    shared?: boolean;
    projectDependencies?: readonly StdGtestContractSpec[];
    dynCallees?: DynCallees;
    excludeTests?: readonly string[];
    filterTests?: readonly string[];
    onResult?: (r: TestResult) => void | Promise<void>;
    onPhase?: (label: string) => void;
}): Promise<StdGtestRun> {
    await initK12();
    const testSrc = readFileSync(opts.testPath, "utf8");
    const contractSrc = readFileSync(opts.contractPath, "utf8");
    const detectedSystemDependencies = depSpecs(systemContracts(opts.core), opts.name, testSrc, contractSrc, opts.core);
    const deps = [...(opts.projectDependencies ?? [])];
    for (const dependency of detectedSystemDependencies) {
        const matchingType = deps.find((candidate) => candidate.stateType === dependency.stateType);
        if (matchingType) {
            if (matchingType.slot !== dependency.slot) {
                throw new Error(`${dependency.stateType} has conflicting GTest slots ` + `${matchingType.slot} and ${dependency.slot}`);
            }
            continue;
        }

        const slotConflict = deps.find((candidate) => candidate.slot === dependency.slot);
        if (slotConflict) {
            throw new Error(`GTest slot ${dependency.slot} is shared by ` + `${slotConflict.stateType} and ${dependency.stateType}`);
        }
        deps.push(dependency);
    }
    const main: StdGtestContractSpec = {
        contractPath: opts.contractPath,
        name: opts.name,
        stateType: opts.stateType,
        slot: opts.slot,
    };
    const shared = !!opts.shared;
    const dynCallees = opts.dynCallees ?? {};
    const ret = { name: opts.name, slot: opts.slot, heavy: shared, backend: opts.backend };

    // contract_testing.h requires clang even when the contract uses the TypeScript compiler.
    opts.onPhase?.("building test harness (clang)");
    const runner = await buildCorpusRunner({
        corpusPath: opts.testPath,
        contractPath: opts.contractPath,
        contractName: opts.name,
        stateType: opts.stateType,
        slot: opts.slot,
        corePath: opts.core,
        outDir: join(opts.scratch, "run_" + opts.name),
        arenaSizeBytes: ARENA,
        dynCallees,
        contractDescriptions: deps
            .filter((dependency) => dynCallees[dependency.stateType])
            .map((dependency) => ({
                index: dependency.slot,
                name: dependency.name,
            })),
    });
    if (!runner.ok || !runner.wasmPath) {
        const err = (runner.stderr ?? "").split("\n").filter((l) => /error:/.test(l))[0] ?? runner.stderr ?? "test-wasm build failed";
        return { ...ret, runnerOk: false, buildError: err, results: [] };
    }
    const runnerBytes = new Uint8Array(readFileSync(runner.wasmPath));

    let contracts: Record<number, Uint8Array>;
    let timings: Record<string, number> | undefined;
    if (opts.backend === "typescript") {
        const o = await typescriptWasms(loadQpiHeader(opts.core), main, deps, shared, opts.onPhase);
        contracts = o.wasms;
        timings = o.timings;
    } else {
        contracts = await clangWasms(opts.core, opts.scratch, main, deps, dynCallees, shared);
    }

    const assetNames = Object.fromEntries([main, ...deps].map((contract) => [contract.slot, contract.name]));
    const results = await runContractTesting(runnerBytes, contracts, {
        mainSlot: main.slot,
        assetNames,
        excludeTests: opts.excludeTests,
        filterTests: opts.filterTests,
        onResult: opts.onResult,
    });
    return { ...ret, runnerOk: true, results, timings };
}

// Built-in convenience: resolve a system contract by name from the core catalog, then runStdGtest its corpus.
export async function runCorpus(opts: {
    name: string;
    core: string;
    backend: CompilerBackend;
    scratch: string;
    excludeTests?: readonly string[];
    filterTests?: readonly string[];
    onResult?: (r: TestResult) => void | Promise<void>;
    onPhase?: (label: string) => void;
}): Promise<CorpusRun> {
    const catalog = systemContracts(opts.core);
    const available = catalog.map((c) => c.name);
    const c = catalog.find((x) => x.name.toLowerCase() === opts.name.toLowerCase());
    const miss = {
        name: c?.name ?? opts.name,
        slot: c?.index ?? 0,
        heavy: false,
        backend: opts.backend,
        runnerOk: false,
        results: [] as TestResult[],
        available,
    };
    if (!c) return { ...miss, found: false, hasCorpus: false };

    const corpusPath = corpusPathFor(opts.core, c.name, c.file);
    if (!corpusPath) return { ...miss, found: true, hasCorpus: false };

    const r = await runStdGtest({
        contractPath: join(opts.core, "src", "contracts", c.file),
        testPath: corpusPath,
        name: c.name,
        stateType: c.stateType,
        slot: c.index,
        core: opts.core,
        backend: opts.backend,
        scratch: opts.scratch,
        shared: systemGtestTier(c.name) === "heavy",
        excludeTests: opts.excludeTests,
        filterTests: opts.filterTests,
        onResult: opts.onResult,
        onPhase: opts.onPhase,
    });
    return { ...r, found: true, hasCorpus: true, available };
}
