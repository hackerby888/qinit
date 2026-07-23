// Run a STANDARD gtest (core-lite `contract_testing.h` suite) against a contract on a fresh isolated engine.
// buildCorpusRunner replaces contract_testing.h with the engine-backed test harness.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContract, buildCorpusRunner, systemContracts } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import {
  compileContract,
  DiagnosticSeverity,
  loadQpiHeader,
} from "@qinit/compile";
import { initK12 } from "@qinit/core";

// System suites that are too memory- or dispatch-heavy for the routine developer gate. They run in
// shared-memory mode and belong to the opt-in heavy suite. This is empirical rather than purely state-size
// based: PULSE/QTF need shared state because their corpora retain state pointers, while NOST has ~1 GiB state.
const HEAVY_SYSTEM_GTEST_NAMES = new Set(["PULSE", "QTF", "QTRY", "GGWP", "QEARN", "NOST"]);
const ARENA = 8 * 1024 * 1024;
const SHARED_START = 0x20000000;
const MAIN_ARENA = 1024 * 1024 * 1024;
const DEP_ARENA = 128 * 1024 * 1024;
const NOST_ARENA = 256 * 1024 * 1024;
const SLACK = 128 * 1024 * 1024;

const mainArenaSize = (name: string): number => (name === "NOST" ? NOST_ARENA : MAIN_ARENA);

// A contract to build/deploy: the .h path + the identity the recipe needs.
interface Spec {
  contractPath: string;
  name: string;
  stateType: string;
  slot: number;
}

export interface StdGtestRun {
  runnerOk: boolean; // the test wasm built
  buildError?: string;
  results: TestResult[];
  name: string;
  slot: number;
  heavy: boolean; // ran in shared-memory mode
  backend: "native" | "local";
  timings?: Record<string, number>; // main contract's per-phase compile time (local backend only)
}

export interface CorpusRun extends StdGtestRun {
  found: boolean; // the name matched a system contract
  hasCorpus: boolean; // a test/contract_<x>.cpp exists
  available: string[]; // system-contract names (for a not-found hint)
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
  return [
    join(core, "test", `contract_${name.toLowerCase()}.cpp`),
    join(core, "test", `contract_${file.replace(/\.h$/, "").toLowerCase()}.cpp`),
  ].find(existsSync);
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
function depSpecs(
  catalog: any[],
  mainName: string,
  testSrc: string,
  contractSrc: string,
  core: string,
): Spec[] {
  const deps: Spec[] = [];
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
      deps.push({ contractPath, name: other.name, stateType: other.stateType, slot: other.index });
    }
  };
  visit(`${testSrc}\n${contractSrc}`);
  return deps;
}

// Native-clang wasm of the main contract + every dep, each at its slot.
async function nativeWasms(
  core: string,
  scratch: string,
  main: Spec,
  deps: Spec[],
  shared: boolean,
): Promise<Record<number, Uint8Array>> {
  const out: Record<number, Uint8Array> = {};
  let nextBase = SHARED_START;
  const build = async (
    s: Spec,
    arenaSz: number,
    isMain: boolean,
    useShared: boolean,
  ): Promise<Uint8Array | null> => {
    const common = {
      contractPath: s.contractPath,
      name: s.name,
      stateType: s.stateType,
      slot: s.slot,
      corePath: core,
      skipVerify: true,
    };
    const p1 = await buildContract({
      ...common,
      outDir: join(scratch, "n_" + s.name),
      ...(useShared ? { arenaSz } : {}),
    });
    if (!p1.so) {
      if (isMain)
        throw new Error(
          "native build: " +
            (p1.stderr ?? "").split("\n").filter((l: string) => /error:/.test(l))[0],
        );
      return null;
    }
    if (!useShared) return new Uint8Array(readFileSync(p1.so));
    const base = nextBase;
    nextBase = align64k(base + stateSizeOf(new Uint8Array(readFileSync(p1.so))) + arenaSz + SLACK);
    const p2 = await buildContract({
      ...common,
      outDir: join(scratch, "ns_" + s.name),
      arenaSz,
      sharedMemBase: base,
    });
    return p2.so ? new Uint8Array(readFileSync(p2.so)) : null;
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

// Our TS-compiler wasm of the main contract + every dep (with callee type resolution). Returns the wasms plus
// the main contract's per-phase compile timings.
async function oursWasms(
  core: string,
  headers: string,
  main: Spec,
  deps: Spec[],
  shared: boolean,
  onPhase?: (label: string) => void,
): Promise<{ wasms: Record<number, Uint8Array>; timings?: Record<string, number> }> {
  const out: Record<number, Uint8Array> = {};
  const callees: any[] = [];
  const calleeSources: any[] = [];
  let nextBase = SHARED_START;
  const emitAt = async (
    o: any,
    arenaSz: number,
  ): Promise<{ wasm: Uint8Array; timings?: Record<string, number> }> => {
    const oph = onPhase
      ? (p: string) => onPhase(`compiling ${o.name} (local TS) — ${p}`)
      : undefined;
    const requireWasm = (r: Awaited<ReturnType<typeof compileContract>>, stage: string) => {
      if (r.wasm.byteLength) return r;
      const errors = r.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.severity === DiagnosticSeverity.ERROR,
        )
        .map((diagnostic) => diagnostic.message);
      throw new Error(`${o.name} ${stage}: ${errors.join("; ") || "compiler returned empty wasm"}`);
    };
    if (!shared) {
      const r = requireWasm(await compileContract({ ...o, arenaSz: ARENA, onPhase: oph }), "build");
      return { wasm: r.wasm, timings: r.timings };
    }
    const p1 = requireWasm(
      await compileContract({ ...o, arenaSz: ARENA }),
      "state-size probe",
    ).wasm; // silent — arena-independent
    const base = nextBase;
    nextBase = align64k(base + stateSizeOf(p1) + arenaSz + SLACK);
    const r = requireWasm(
      await compileContract({ ...o, arenaSz, sharedMemBase: base, onPhase: oph }),
      "shared-memory build",
    );
    return { wasm: r.wasm, timings: r.timings };
  };
  for (const d of deps) {
    const dsrc = readFileSync(d.contractPath, "utf8");
    // Compile dependencies in order so each sees earlier IDL and source context.
    const depOpts = {
      source: dsrc,
      name: d.name,
      slot: d.slot,
      qpiHeader: headers,
      callees: callees.length ? callees : undefined,
      calleeSources: calleeSources.length ? calleeSources : undefined,
    };
    const dr = await compileContract({ ...depOpts, arenaSz: ARENA });
    if (!dr.wasm.byteLength) {
      const errors = dr.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.severity === DiagnosticSeverity.ERROR,
        )
        .map((diagnostic) => diagnostic.message);
      throw new Error(
        `local dependency ${d.name}: ${errors.join("; ") || "compiler returned empty wasm"}`,
      );
    }
    out[d.slot] =
      shared && main.name !== "NOST" ? (await emitAt(depOpts, DEP_ARENA)).wasm : dr.wasm;
    callees.push({
      name: d.name,
      index: d.slot,
      functions: Object.fromEntries(
        dr.idl.functions.map((f) => [
          f.name,
          { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize },
        ]),
      ),
      procedures: Object.fromEntries(
        dr.idl.procedures.map((p) => [
          p.name,
          { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize },
        ]),
      ),
    });
    calleeSources.push({ name: d.name, source: dsrc });
  }
  const csrc = readFileSync(main.contractPath, "utf8");
  const m = await emitAt(
    {
      source: csrc,
      name: main.name,
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
  backend: "native" | "local";
  scratch: string;
  shared?: boolean;
  onResult?: (r: TestResult) => void | Promise<void>;
  onPhase?: (label: string) => void;
}): Promise<StdGtestRun> {
  await initK12();
  const testSrc = readFileSync(opts.testPath, "utf8");
  const contractSrc = readFileSync(opts.contractPath, "utf8");
  const deps = depSpecs(systemContracts(opts.core), opts.name, testSrc, contractSrc, opts.core);
  const main: Spec = {
    contractPath: opts.contractPath,
    name: opts.name,
    stateType: opts.stateType,
    slot: opts.slot,
  };
  const shared = !!opts.shared;
  const ret = { name: opts.name, slot: opts.slot, heavy: shared, backend: opts.backend };

  // The harness is ALWAYS native clang (our compiler can't build contract_testing.h), and clang is the slow
  // step even in --local — label it so the wait isn't mistaken for our compiler.
  opts.onPhase?.("building test harness (native clang — the slow step)");
  const runner = await buildCorpusRunner({
    corpusPath: opts.testPath,
    contractPath: opts.contractPath,
    name: opts.name,
    stateType: opts.stateType,
    slot: opts.slot,
    corePath: opts.core,
    outDir: join(opts.scratch, "run_" + opts.name),
    arenaSz: ARENA,
  });
  if (!runner.ok || !runner.so) {
    const err =
      (runner.stderr ?? "").split("\n").filter((l) => /error:/.test(l))[0] ??
      runner.stderr ??
      "test-wasm build failed";
    return { ...ret, runnerOk: false, buildError: err, results: [] };
  }
  const runnerBytes = new Uint8Array(readFileSync(runner.so));

  let contracts: Record<number, Uint8Array>;
  let timings: Record<string, number> | undefined;
  if (opts.backend === "local") {
    const o = await oursWasms(
      opts.core,
      loadQpiHeader(opts.core),
      main,
      deps,
      shared,
      opts.onPhase,
    );
    contracts = o.wasms;
    timings = o.timings;
  } else {
    contracts = await nativeWasms(opts.core, opts.scratch, main, deps, shared);
  }

  const assetNames = Object.fromEntries(
    [main, ...deps].map((contract) => [contract.slot, contract.name]),
  );
  const results = await runContractTesting(runnerBytes, contracts, {
    mainSlot: main.slot,
    assetNames,
    onResult: opts.onResult,
  });
  return { ...ret, runnerOk: true, results, timings };
}

// Built-in convenience: resolve a system contract by name from the core catalog, then runStdGtest its corpus.
export async function runCorpus(opts: {
  name: string;
  core: string;
  backend: "native" | "local";
  scratch: string;
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
    onResult: opts.onResult,
    onPhase: opts.onPhase,
  });
  return { ...r, found: true, hasCorpus: true, available };
}
