// Run a system contract's REAL gtest (core-lite test/contract_<x>.cpp, the `contract_testing.h` suite) on a
// fresh isolated engine — the path `qinit gtest --corpus` uses. buildCorpusRunner swaps the corpus's
// `#include "contract_testing.h"` for the engine-backed `wasm_contract_testing.h` and compiles it to a test
// wasm (native clang); the contract under test is built either by native clang or by our TS compiler
// (--local), deployed alongside its referenced sibling contracts, then driven by runContractTesting.
//
// Heavy suites (QEARN/QTF/… hundreds of MB of state) run in shared-memory mode: the contract wasms live
// inside the runner's own memory above SHARED_START. Pass 1 builds normally to read state_size; pass 2
// relinks/re-emits at the packed base. This mirrors packages/compile/tests/_probe_dual.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildContract, buildCorpusRunner, systemContracts } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "@qinit/compile";
import { initK12 } from "@qinit/core";

const HEAVY = new Set(["PULSE", "QTF", "QTRY", "GGWP", "QEARN"]);
const ARENA = 8 * 1024 * 1024;
const SHARED_START = 0x20000000;
const MAIN_ARENA = 1024 * 1024 * 1024;
const DEP_ARENA = 128 * 1024 * 1024;
const SLACK = 128 * 1024 * 1024;

export interface CorpusRun {
  found: boolean;                 // the name matched a system contract
  hasCorpus: boolean;             // a test/contract_<x>.cpp exists
  runnerOk: boolean;              // the test wasm built
  buildError?: string;
  results: TestResult[];
  name: string;
  slot: number;
  heavy: boolean;
  backend: "native" | "local";
  available: string[];           // system-contract names (for a not-found hint)
  timings?: Record<string, number>; // main contract's per-phase compile time (local backend only)
}

// Read a contract wasm's exported state_size without wiring real host imports (stub every import to 0).
function stateSizeOf(wasm: Uint8Array): number {
  const mod = new WebAssembly.Module(wasm as unknown as BufferSource);
  const imports: Record<string, Record<string, unknown>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== "function") continue;
    const results = ((imp as { type?: { results?: string[] } }).type?.results ?? []);
    (imports[imp.module] ??= {})[imp.name] = results.includes("i64") ? () => 0n : () => 0;
  }
  const ex = new WebAssembly.Instance(mod, imports as WebAssembly.Imports).exports as { state_size(): number };
  return ex.state_size() >>> 0;
}

// Sibling contracts referenced by the corpus or the contract source (deployed + built alongside the target).
function depNamesOf(catalog: any[], c: any, corpusSrc: string, contractSrc: string): any[] {
  const deps: any[] = [];
  for (const other of catalog) {
    if (other.name === c.name) continue;
    const re = new RegExp(`\\b${other.name}(::|_[A-Z0-9])`);
    if (re.test(corpusSrc) || re.test(contractSrc)) deps.push(other);
  }
  return deps;
}

// Native-clang wasm of the contract at its slot + every referenced dep at its slot.
async function nativeWasms(core: string, scratch: string, c: any, deps: any[], shared: boolean): Promise<Record<number, Uint8Array>> {
  const out: Record<number, Uint8Array> = {};
  let nextBase = SHARED_START;
  const build = async (cc: any, arenaSz: number): Promise<Uint8Array | null> => {
    const common = { contractPath: join(core, "src", "contracts", cc.file), name: cc.name, stateType: cc.stateType, slot: cc.index, corePath: core };
    const p1 = await buildContract({ ...common, outDir: join(scratch, "n_" + cc.name), skipVerify: true, ...(shared ? { arenaSz } : {}) });
    if (!p1.so) {
      if (cc === c) throw new Error("native build: " + (p1.stderr ?? "").split("\n").filter((l: string) => /error:/.test(l))[0]);
      return null;
    }
    if (!shared) return new Uint8Array(readFileSync(p1.so));
    const base = nextBase;
    nextBase = (base + stateSizeOf(new Uint8Array(readFileSync(p1.so))) + arenaSz + SLACK + 0xffff) & ~0xffff;
    const p2 = await buildContract({ ...common, outDir: join(scratch, "ns_" + cc.name), skipVerify: true, arenaSz, sharedMemBase: base });
    return p2.so ? new Uint8Array(readFileSync(p2.so)) : null;
  };
  const main = await build(c, MAIN_ARENA);
  if (main) out[c.index] = main;
  for (const d of deps) {
    const w = await build(d, DEP_ARENA);
    if (w) out[d.index] = w;
  }
  return out;
}

// Our TS-compiler wasm of the contract at its slot + every referenced dep (with callee type resolution).
// Returns the wasms plus the main contract's per-phase compile timings (for a summary breakdown).
async function oursWasms(core: string, headers: string, c: any, deps: any[], shared: boolean, onPhase?: (label: string) => void): Promise<{ wasms: Record<number, Uint8Array>; timings?: Record<string, number> }> {
  const out: Record<number, Uint8Array> = {};
  const callees: any[] = [];
  const calleeSources: any[] = [];
  let nextBase = SHARED_START;
  const emitAt = async (o: any, arenaSz: number): Promise<{ wasm: Uint8Array; timings?: Record<string, number> }> => {
    const oph = onPhase ? (p: string) => onPhase(`compiling ${o.name} (local TS) — ${p}`) : undefined;
    if (!shared) {
      const r = await compileContract({ ...o, arenaSz: ARENA, onPhase: oph });
      return { wasm: r.wasm, timings: r.timings };
    }
    const p1 = (await compileContract({ ...o, arenaSz: ARENA })).wasm; // state_size probe (silent — arena-independent)
    const base = nextBase;
    nextBase = (base + stateSizeOf(p1) + arenaSz + SLACK + 0xffff) & ~0xffff;
    const r = await compileContract({ ...o, arenaSz, sharedMemBase: base, onPhase: oph });
    return { wasm: r.wasm, timings: r.timings };
  };
  for (const d of deps) {
    const dsrc = readFileSync(join(core, "src", "contracts", d.file), "utf8");
    const dr = await compileContract({ source: dsrc, name: d.name, slot: d.index, qpiHeader: headers, arenaSz: ARENA });
    out[d.index] = shared ? (await emitAt({ source: dsrc, name: d.name, slot: d.index, qpiHeader: headers }, DEP_ARENA)).wasm : dr.wasm;
    callees.push({
      name: d.name, index: d.index,
      functions: Object.fromEntries(dr.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }])),
      procedures: Object.fromEntries(dr.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }])),
    });
    calleeSources.push({ name: d.name, source: dsrc });
  }
  const csrc = readFileSync(join(core, "src", "contracts", c.file), "utf8");
  const main = await emitAt({ source: csrc, name: c.name, slot: c.index, qpiHeader: headers, callees: callees.length ? callees : undefined, calleeSources: calleeSources.length ? calleeSources : undefined }, MAIN_ARENA);
  out[c.index] = main.wasm;
  return { wasms: out, timings: main.timings };
}

export async function runCorpus(opts: { name: string; core: string; backend: "native" | "local"; scratch: string; onResult?: (r: TestResult) => void | Promise<void>; onPhase?: (label: string) => void }): Promise<CorpusRun> {
  await initK12();
  const catalog = systemContracts(opts.core);
  const available = catalog.map((c) => c.name);
  const c = catalog.find((x) => x.name.toLowerCase() === opts.name.toLowerCase());
  const base: Omit<CorpusRun, "found" | "hasCorpus" | "runnerOk" | "results"> = {
    name: c?.name ?? opts.name, slot: c?.index ?? 0, heavy: c ? HEAVY.has(c.name) : false, backend: opts.backend, available,
  };
  if (!c) return { ...base, found: false, hasCorpus: false, runnerOk: false, results: [] };

  const corpusPath = [
    join(opts.core, "test", `contract_${c.name.toLowerCase()}.cpp`),
    join(opts.core, "test", `contract_${String(c.file).replace(/\.h$/, "").toLowerCase()}.cpp`),
  ].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
  if (!corpusPath) return { ...base, found: true, hasCorpus: false, runnerOk: false, results: [] };

  const corpusSrc = readFileSync(corpusPath, "utf8");
  const contractSrc = readFileSync(join(opts.core, "src", "contracts", c.file), "utf8");
  const deps = depNamesOf(catalog, c, corpusSrc, contractSrc);
  const shared = HEAVY.has(c.name);

  // The test harness is ALWAYS native clang (our compiler can't build lite_test.h/contract_testing.h), and
  // clang is the slow step even in --local — surface it as such so the wait isn't mistaken for our compiler.
  opts.onPhase?.("building test harness (native clang — the slow step)");
  const runner = await buildCorpusRunner({
    corpusPath, contractPath: join(opts.core, "src", "contracts", c.file),
    name: c.name, stateType: c.stateType, slot: c.index, corePath: opts.core,
    outDir: join(opts.scratch, "run_" + c.name), arenaSz: ARENA,
  });
  if (!runner.ok || !runner.so) {
    const err = (runner.stderr ?? "").split("\n").filter((l) => /error:/.test(l))[0] ?? runner.stderr ?? "test-wasm build failed";
    return { ...base, found: true, hasCorpus: true, runnerOk: false, buildError: err, results: [] };
  }
  const runnerBytes = new Uint8Array(readFileSync(runner.so));

  let contracts: Record<number, Uint8Array>;
  let timings: Record<string, number> | undefined;
  if (opts.backend === "local") {
    const o = await oursWasms(opts.core, loadQpiHeader(opts.core), c, deps, shared, opts.onPhase);
    contracts = o.wasms;
    timings = o.timings;
  } else {
    contracts = await nativeWasms(opts.core, opts.scratch, c, deps, shared);
  }

  const results = await runContractTesting(runnerBytes, contracts, { onResult: opts.onResult });
  return { ...base, found: true, hasCorpus: true, runnerOk: true, results, timings };
}
