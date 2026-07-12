import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileContract, loadQpiHeader } from "../../src/index";
import { buildCorpusRunner, buildContract, systemContracts } from "@qinit/build";
import { runContractTesting } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { appendFileSync } from "node:fs";
import { CORE } from "./qutil-bridge";

await initK12();
const BOARD = process.env.BOARD_OUT;
const emit = (line: string) => { console.log(line); if (BOARD) appendFileSync(BOARD, line + "\n"); };
const ARENA = 8 * 1024 * 1024;
const SCRATCH = "/tmp/claude-1000/-home-kali-Projects-core-lite/87fbc69c-6675-41cb-94cb-1c730c00fab8/scratchpad/dual";
const headers = loadQpiHeader(CORE);
const catalog = systemContracts(CORE);
const HEAVY = new Set(["PULSE", "QTF", "QTRY", "GGWP", "QEARN", "NOST"]); // NOST: ~1GB state — shadow-sync pulls dominate outside shared mode
const only = process.argv[2];

// contracts referenced by the corpus or the contract source (deployed + compiled alongside the target).
function depNamesOf(c: any, corpusSrc: string, contractSrc: string): any[] {
  const deps: any[] = [];
  for (const other of catalog) {
    if (other.name === c.name) continue;
    const re = new RegExp(`\\b${other.name}(::|_[A-Z0-9])`);
    if (re.test(corpusSrc) || re.test(contractSrc)) deps.push(other);
  }
  return deps;
}

// Shared-memory layout (heavy corpora): contracts live inside the runner's memory above SHARED_START.
const SHARED_START = 0x20000000;
const MAIN_ARENA = 1024 * 1024 * 1024;
const DEP_ARENA = 128 * 1024 * 1024;
const SLACK = 128 * 1024 * 1024;

function stubExports(wasm: Uint8Array): any {
  const mod = new WebAssembly.Module(wasm as unknown as BufferSource);
  const imports: Record<string, Record<string, any>> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== "function") continue;
    const results = ((imp as any).type?.results ?? []) as string[];
    (imports[imp.module] ??= {})[imp.name] = results.includes("i64") ? () => 0n : () => 0;
  }
  return new WebAssembly.Instance(mod, imports as any).exports;
}

// native-clang wasm of a contract (the oracle) at its slot, + every referenced dep at its slot.
async function nativeWasms(c: any, deps: any[], shared: boolean): Promise<Record<number, Uint8Array>> {
  const out: Record<number, Uint8Array> = {};
  let nextBase = SHARED_START;
  const build = async (cc: any, arenaSz: number): Promise<Uint8Array | null> => {
    const common = { contractPath: join(CORE, "src", "contracts", cc.file), name: cc.name, stateType: cc.stateType, slot: cc.index, corePath: CORE };
    const p1 = await buildContract({ ...common, outDir: join(SCRATCH, "n_" + cc.name), ...(shared ? { arenaSz } : {}) });
    if (!p1.so) { if (cc === c) throw new Error("native build: " + (p1.stderr ?? "").split("\n").filter((l: string) => /error:/.test(l))[0]); return null; }
    if (!shared) return new Uint8Array(readFileSync(p1.so));
    const stateSize = stubExports(new Uint8Array(readFileSync(p1.so))).state_size() >>> 0;
    const base = nextBase;
    nextBase = (base + stateSize + arenaSz + SLACK + 0xffff) & ~0xffff;
    const p2 = await buildContract({ ...common, outDir: join(SCRATCH, "ns_" + cc.name), arenaSz, sharedMemBase: base });
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
async function oursWasms(c: any, deps: any[], shared: boolean): Promise<Record<number, Uint8Array>> {
  const out: Record<number, Uint8Array> = {};
  const callees: any[] = [];
  const calleeSources: any[] = [];
  let nextBase = SHARED_START;
  const emitAt = async (o: any, arenaSz: number): Promise<Uint8Array> => {
    if (!shared) return (await compileContract({ ...o, arenaSz: ARENA })).wasm;
    const p1 = (await compileContract({ ...o, arenaSz: ARENA })).wasm; // state_size is arena-independent

    const stateSize = stubExports(p1).state_size() >>> 0;
    const base = nextBase;
    nextBase = (base + stateSize + arenaSz + SLACK + 0xffff) & ~0xffff;
    return (await compileContract({ ...o, arenaSz, sharedMemBase: base })).wasm;
  };
  // A dep may itself CALL another system contract (QRWA's corpus deploys QUTIL/QSWAP, which CALL QX) — compile every
  const idlCache = new Map<string, { entry: any; source: string }>();
  const calleeInfo = async (cc: any) => {
    if (idlCache.has(cc.name)) return idlCache.get(cc.name)!;
    const source = readFileSync(join(CORE, "src", "contracts", cc.file), "utf8");
    const r = await compileContract({ source, name: cc.stateType ?? cc.name, slot: cc.index, qpiHeader: headers, arenaSz: ARENA, strict: false });
    const info = {
      source,
      entry: {
        name: cc.stateType ?? cc.name, index: cc.index,
        functions: Object.fromEntries(r.idl.functions.map((f: any) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }])),
        procedures: Object.fromEntries(r.idl.procedures.map((p: any) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }])),
      },
    };
    idlCache.set(cc.name, info);
    return info;
  };
  const depCalleesOf = async (src: string, self: any) => {
    const cs: any[] = [];
    const css: any[] = [];
    for (const other of catalog) {
      if (other.name === self.name) continue;
      if (!new RegExp(`\\b(${other.name}|${other.stateType})(::|_[A-Z0-9])`).test(src)) continue;
      const info = await calleeInfo(other);
      cs.push(info.entry);
      css.push({ name: info.entry.name, source: info.source });
    }
    return { cs, css };
  };

  for (const d of deps) {
    const dsrc = readFileSync(join(CORE, "src", "contracts", d.file), "utf8");
    const { cs, css } = await depCalleesOf(dsrc, d);
    const dopts = { source: dsrc, name: d.name, slot: d.index, qpiHeader: headers, callees: cs.length ? cs : undefined, calleeSources: css.length ? css : undefined };
    const dr = await compileContract({ ...dopts, arenaSz: ARENA });
    out[d.index] = shared ? await emitAt(dopts, DEP_ARENA) : dr.wasm;
    const fns = Object.fromEntries(dr.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }]));
    const procs = Object.fromEntries(dr.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }]));
    callees.push({ name: d.name, index: d.index, functions: fns, procedures: procs });
    calleeSources.push({ name: d.name, source: dsrc });
  }
  const csrc = readFileSync(join(CORE, "src", "contracts", c.file), "utf8");
  out[c.index] = await emitAt({ source: csrc, name: c.name, slot: c.index, qpiHeader: headers, callees: callees.length ? callees : undefined, calleeSources: calleeSources.length ? calleeSources : undefined }, MAIN_ARENA);
  return out;
}

for (const c of catalog) {
  if (only ? c.name !== only : HEAVY.has(c.name)) continue;
  const corpusCandidates = [
    join(CORE, "test", `contract_${c.name.toLowerCase()}.cpp`),
    join(CORE, "test", `contract_${String(c.file).replace(/\.h$/, "").toLowerCase()}.cpp`),
  ];
  const corpusPath = corpusCandidates.find((p) => { try { readFileSync(p); return true; } catch { return false; } }) ?? corpusCandidates[0];
  let src: string;
  try { src = readFileSync(corpusPath, "utf8"); } catch { continue; }
  const deps = depNamesOf(c, src, readFileSync(join(CORE, "src", "contracts", c.file), "utf8"));
  try {
    const runner = await buildCorpusRunner({ corpusPath, contractPath: join(CORE, "src", "contracts", c.file), name: c.name, stateType: c.stateType, slot: c.index, corePath: CORE, outDir: join(SCRATCH, "run_" + c.name), arenaSz: ARENA });
    if (!runner.ok || !runner.so) { emit(`  HARNESS-BUILD  ${c.name.padEnd(11)} ${(runner.stderr ?? "").split("\n").filter((l) => /error:/.test(l))[0]?.replace(/.*\//, "").slice(0, 64) ?? "?"}`); continue; }
    const runnerBytes = new Uint8Array(readFileSync(runner.so));
    const shared = HEAVY.has(c.name);
    // slot -> ticker (contractDescriptions assetName) so qpi.distributeDividends can find each contract's share asset in the universe.
    const assetNames = Object.fromEntries([c, ...deps].map((cc: any) => [cc.index, cc.name]));
    const nat = await runContractTesting(runnerBytes, await nativeWasms(c, deps, shared), { assetNames });
    console.log(`  [native done: ${nat.filter((t) => t.passed).length}/${nat.length}]`);
    const our = await runContractTesting(runnerBytes, await oursWasms(c, deps, shared), { assetNames });
    const byName = new Map(nat.map((t) => [t.name, t.passed]));
    let green = 0, oursBug = 0, harness = 0; let firstBug = "";
    for (const t of our) {
      const natPass = byName.get(t.name);
      if (t.passed && natPass) green++;
      else if (natPass && !t.passed) {
        oursBug++;
        if (!firstBug) firstBug = `${t.name}: ${t.message.split("\n")[0].slice(0, 50)}`;
        console.log(`  OURS-FAIL ${t.name}\n${t.message}`);
      }
      else harness++;
    }
    const tag = oursBug === 0 && harness === 0 ? "ok          " : oursBug > 0 ? "OURS-BUG    " : "harness-gap ";
    emit(`  ${tag} ${c.name.padEnd(11)} green ${green}/${our.length}  ours-bug ${oursBug}  harness ${harness}${firstBug ? "  | " + firstBug : ""}`);
  } catch (e: any) { console.log(`  THROW        ${c.name.padEnd(11)} ${String(e.message).slice(0, 64)}`); }
}
