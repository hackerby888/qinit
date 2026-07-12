// Dual-backend corpus verification: native clang + TS compiler.
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initK12 } from "@qinit/core";
import { runContractTesting } from "@qinit/engine";
import { buildContract, buildCorpusRunner } from "@qinit/build";
import { compileContract, loadQpiHeader, type CompileResult, type CalleeIdl } from "../../src/index";
import { CORE, wasiAvailable } from "../support/qutil-bridge";

interface CalleeSpec {
  name: string;
  header: string;
  stateType: string;
  slot: number;
}

interface Spec {
  corpus: string;
  header: string;
  name: string;
  stateType: string;
  slot: number;
  callees: CalleeSpec[];
}

const ARENA = 8 * 1024 * 1024;

const SPECS: Spec[] = [
  {
    corpus: "contract_qutil.cpp",
    header: "QUtil.h",
    name: "QUTIL",
    stateType: "QUTIL",
    slot: 4,
    callees: [{ name: "QX", header: "Qx.h", stateType: "QX", slot: 1 }],
  },
  {
    corpus: "contract_qrp.cpp",
    header: "QReservePool.h",
    name: "QRP",
    stateType: "QRP",
    slot: 21,
    callees: [{ name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 }],
  },
  {
    corpus: "contract_vottunbridge.cpp",
    header: "VottunBridge.h",
    name: "VOTTUNBRIDGE",
    stateType: "VOTTUNBRIDGE",
    slot: 25,
    callees: [],
  },
  {
    corpus: "contract_qearn.cpp",
    header: "Qearn.h",
    name: "QEARN",
    stateType: "QEARN",
    slot: 9,
    callees: [],
  },
  {
    corpus: "contract_gqmprop.cpp",
    header: "GeneralQuorumProposal.h",
    name: "GQMPROP",
    stateType: "GQMPROP",
    slot: 6,
    callees: [],
  },
  {
    corpus: "contract_ccf.cpp",
    header: "ComputorControlledFund.h",
    name: "CCF",
    stateType: "CCF",
    slot: 8,
    callees: [],
  },
  {
    corpus: "contract_random.cpp",
    header: "Random.h",
    name: "RANDOM",
    stateType: "RANDOM",
    slot: 3,
    callees: [],
  },
  {
    corpus: "contract_qip.cpp",
    header: "QIP.h",
    name: "QIP",
    stateType: "QIP",
    slot: 18,
    callees: [{ name: "QX", header: "Qx.h", stateType: "QX", slot: 1 }],
  },
  {
    corpus: "contract_qraffle.cpp",
    header: "QRaffle.h",
    name: "QRAFFLE",
    stateType: "QRAFFLE",
    slot: 19,
    callees: [{ name: "QX", header: "Qx.h", stateType: "QX", slot: 1 }],
  },
  {
    corpus: "contract_qduel.cpp",
    header: "QDuel.h",
    name: "QDUEL",
    stateType: "QDUEL",
    slot: 23,
    callees: [{ name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 }],
  },
  {
    corpus: "contract_rl.cpp",
    header: "RandomLottery.h",
    name: "RL",
    stateType: "RL",
    slot: 16,
    callees: [],
  },
  {
    corpus: "contract_ggwp.cpp",
    header: "GGWP.h",
    name: "GGWP",
    stateType: "WOLFPACK",
    slot: 28,
    callees: [],
  },
  {
    corpus: "contract_qtf.cpp",
    header: "QThirtyFour.h",
    name: "QTF",
    stateType: "QTF",
    slot: 22,
    callees: [
      { name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 },
      { name: "QRP", header: "QReservePool.h", stateType: "QRP", slot: 21 },
    ],
  },
  {
    corpus: "contract_pulse.cpp",
    header: "Pulse.h",
    name: "PULSE",
    stateType: "PULSE",
    slot: 24,
    callees: [
      { name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 },
      { name: "QRP", header: "QReservePool.h", stateType: "QRP", slot: 21 },
      { name: "QTF", header: "QThirtyFour.h", stateType: "QTF", slot: 22 },
      { name: "QX", header: "Qx.h", stateType: "QX", slot: 1 },
    ],
  },
];

function calleeIdlFrom(name: string, index: number, r: CompileResult): CalleeIdl {
  const fns = Object.fromEntries(
    r.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }])
  );
  const procs = Object.fromEntries(
    r.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }])
  );
  return { name, index, functions: fns, procedures: procs };
}

async function buildRunnerFor(spec: Spec, outDir: string): Promise<Uint8Array> {
  const r = await buildCorpusRunner({
    corpusPath: `${CORE}/test/${spec.corpus}`,
    contractPath: `${CORE}/src/contracts/${spec.header}`,
    name: spec.name,
    stateType: spec.stateType,
    slot: spec.slot,
    corePath: CORE,
    outDir,
    arenaSz: ARENA,
  });

  if (!r.ok || !r.so) {
    const lines = (r.stderr ?? "").split("\n").filter((l) => /error:|undefined|cannot|fatal/i.test(l));
    throw new Error(`runner build failed: ${lines.slice(0, 6).join(" | ")}`);
  }

  return new Uint8Array(readFileSync(r.so));
}

async function buildOurs(spec: Spec): Promise<Record<number, Uint8Array>> {
  const headers = loadQpiHeader(CORE);
  const out: Record<number, Uint8Array> = {};
  const calleeResults: CompileResult[] = [];

  for (const callee of spec.callees) {
    const src = readFileSync(`${CORE}/src/contracts/${callee.header}`, "utf8");
    const prior = spec.callees.slice(0, calleeResults.length);
    const priorIdl = prior.map((item, index) => calleeIdlFrom(item.name, item.slot, calleeResults[index]));
    const priorSources = prior.map((item) => ({ name: item.name, source: readFileSync(`${CORE}/src/contracts/${item.header}`, "utf8") }));
    const r = await compileContract({
      source: src, name: callee.name, slot: callee.slot, qpiHeader: headers, arenaSz: ARENA,
      callees: priorIdl.length ? priorIdl : undefined,
      calleeSources: priorSources.length ? priorSources : undefined,
    });
    const errs = r.diagnostics.filter((d) => d.severity === "error");
    if (errs.length) {
      throw new Error(`ours ${callee.name}: ${errs.map((d) => `L${d.span.line} ${d.message}`).join("; ")}`);
    }
    calleeResults.push(r);
    out[callee.slot] = r.wasm;
  }

  const mainSrc = readFileSync(`${CORE}/src/contracts/${spec.header}`, "utf8");
  const callees = spec.callees.map((c, i) => calleeIdlFrom(c.name, c.slot, calleeResults[i]));
  const calleeSources = spec.callees.map((c) => ({ name: c.name, source: readFileSync(`${CORE}/src/contracts/${c.header}`, "utf8") }));

  const mainR = await compileContract({ source: mainSrc, name: spec.name, slot: spec.slot, qpiHeader: headers, arenaSz: ARENA, callees, calleeSources });
  const mainErrs = mainR.diagnostics.filter((d) => d.severity === "error");
  if (mainErrs.length) {
    throw new Error(`ours ${spec.name}: ${mainErrs.map((d) => `L${d.span.line} ${d.message}`).join("; ")}`);
  }
  out[spec.slot] = mainR.wasm;

  return out;
}

async function buildNative(spec: Spec, outDir: string): Promise<Record<number, Uint8Array>> {
  const out: Record<number, Uint8Array> = {};

  for (const callee of spec.callees) {
    const r = await buildContract({
      contractPath: `${CORE}/src/contracts/${callee.header}`,
      name: callee.name,
      stateType: callee.stateType,
      slot: callee.slot,
      corePath: CORE,
      outDir,
      arenaSz: ARENA,
      skipVerify: true,
    });
    if (!r.ok || !r.so) {
      throw new Error(`native ${callee.name}: ${(r.stderr ?? "").split("\n").slice(-3).join(" | ")}`);
    }
    out[callee.slot] = new Uint8Array(readFileSync(r.so));
  }

  const mainR = await buildContract({
    contractPath: `${CORE}/src/contracts/${spec.header}`,
    name: spec.name,
    stateType: spec.stateType,
    slot: spec.slot,
    corePath: CORE,
    outDir,
    arenaSz: ARENA,
    skipVerify: true,
  });
  if (!mainR.ok || !mainR.so) {
    throw new Error(`native ${spec.name}: ${(mainR.stderr ?? "").split("\n").slice(-3).join(" | ")}`);
  }
  out[spec.slot] = new Uint8Array(readFileSync(mainR.so));

  return out;
}

// Child entry: build the runner + one backend for one spec, run it, and record the outcome to
async function runSingleCell(): Promise<void> {
  const outPath = process.env.SC_OUT!;
  const [name, mode] = (process.env.SC_SINGLE ?? "").split("|");
  const spec = SPECS.find((s) => s.name === name);

  if (!spec) {
    appendFileSync(outPath, "RUNNER err\nERR unknown spec\n");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), `qinit-cell-${name.toLowerCase()}-${mode}-`));
  let runnerOk = false;

  try {
    const runner = await buildRunnerFor(spec, dir);
    runnerOk = true;
    appendFileSync(outPath, "RUNNER ok\n");

    const contracts = mode === "ours" ? await buildOurs(spec) : await buildNative(spec, dir);
    const results = await runContractTesting(runner, contracts);
    const passed = results.filter((r) => r.passed).length;
    appendFileSync(outPath, `SCORE ${passed}/${results.length}\n`);
    for (const result of results.filter((item) => !item.passed)) {
      appendFileSync(outPath, `FAIL ${result.name} — ${result.message.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }
  } catch (e: any) {
    if (!runnerOk) {
      appendFileSync(outPath, "RUNNER err\n");
    }
    const msg = String(e?.message ?? e).split("\n")[0].slice(0, 200);
    appendFileSync(outPath, `ERR ${msg}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Cell {
  runner: string;
  score: string;
}

// Spawn this file under `bun test` with SC_SINGLE set, kill it at a deadline, and read its temp result.
async function spawnCell(name: string, mode: string, timeoutMs: number): Promise<Cell> {
  const outPath = join(tmpdir(), `qinit-cell-${name.toLowerCase()}-${mode}-${Date.now()}.txt`);
  writeFileSync(outPath, "");

  const proc = Bun.spawn([process.execPath, "test", import.meta.path], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, SC_SINGLE: `${name}|${mode}`, SC_OUT: outPath, SC_SWEEP: "" },
    stdout: "ignore",
    stderr: "ignore",
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill(9);
  }, timeoutMs);

  await proc.exited;
  clearTimeout(timer);

  const text = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  rmSync(outPath, { force: true });

  const runner = /RUNNER ok/.test(text) ? "ok" : "err";

  const scoreMatch = text.match(/SCORE (\d+\/\d+)/);
  let score: string;
  if (scoreMatch) {
    score = scoreMatch[1];
  } else if (killed) {
    score = "hang";
  } else {
    score = "err";
  }

  return { runner, score };
}

describe("sc-corpus — dual-backend EASY-tier sweep", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("__single-cell child entry", async () => {
    if (!process.env.SC_SINGLE) {
      return;
    }

    await runSingleCell();
  }, 600000);

  test("QUTIL parity: native >= 51 AND ours >= 51 via qinit harness", async () => {
    if (process.env.SC_SINGLE || process.env.SC_OURS_ONLY) {
      return;
    }
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }

    const spec = SPECS.find((s) => s.name === "QUTIL")!;
    const dir = mkdtempSync(join(tmpdir(), "qinit-parity-qutil-"));

    try {
      const runner = await buildRunnerFor(spec, dir);
      const native = await buildNative(spec, dir);
      const ours = await buildOurs(spec);

      const nativeResults = await runContractTesting(runner, native);
      const oursResults = await runContractTesting(runner, ours);

      const nativePassed = nativeResults.filter((r) => r.passed).length;
      const oursPassed = oursResults.filter((r) => r.passed).length;

      console.log(`\n  [native] QUTIL: ${nativePassed}/${nativeResults.length} PASS`);
      console.log(`  [ours]   QUTIL: ${oursPassed}/${oursResults.length} PASS`);

      for (const r of nativeResults.filter((r) => !r.passed).slice(0, 6)) {
        console.log(`  FAIL native  ${r.name} — ${r.message.replace(/\n/g, " ").slice(0, 100)}`);
      }
      for (const r of oursResults.filter((r) => !r.passed).slice(0, 6)) {
        console.log(`  FAIL ours    ${r.name} — ${r.message.replace(/\n/g, " ").slice(0, 100)}`);
      }

      expect(nativePassed).toBeGreaterThanOrEqual(51);
      expect(oursPassed).toBeGreaterThanOrEqual(51);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600000);

  test("EASY-tier scoreboard (SC_SWEEP=1)", async () => {
    if (!process.env.SC_SWEEP || process.env.SC_SINGLE) {
      return;
    }
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping sweep)");
      return;
    }

    interface Row {
      name: string;
      runner: string;
      native: string;
      ours: string;
    }

    const CELL_TIMEOUT = 120000;
    const rows: Row[] = [];

    const selectedNames = new Set((process.env.SC_SWEEP_FILTER ?? "").split(",").filter(Boolean));
    const selected = selectedNames.size ? SPECS.filter((spec) => selectedNames.has(spec.name)) : SPECS;
    const oursOnly = !!process.env.SC_OURS_ONLY;

    for (const spec of selected) {
      const native = oursOnly ? { runner: "-", score: "skip" } : await spawnCell(spec.name, "native", CELL_TIMEOUT);
      const ours = await spawnCell(spec.name, "ours", CELL_TIMEOUT);

      const runner = native.runner === "ok" || ours.runner === "ok" ? "ok" : "err";
      rows.push({ name: spec.name, runner, native: native.score, ours: ours.score });
      console.log(`  [${spec.name}] runner:${runner}  native:${native.score}  ours:${ours.score}`);
    }

    const col = (s: string, w: number) => s.padEnd(w);
    const header = `${col("CONTRACT", 16)} ${col("RUNNER", 8)} ${col("NATIVE", 10)} ${col("OURS", 10)}`;
    const sep = "-".repeat(header.length);

    const tableLines = [sep, header, sep];
    for (const row of rows) {
      tableLines.push(`${col(row.name, 16)} ${col(row.runner, 8)} ${col(row.native, 10)} ${col(row.ours, 10)}`);
    }
    tableLines.push(sep);

    const scored = (v: string) => /^\d+\/\d+$/.test(v);
    const nativeScored = rows.filter((r) => scored(r.native)).length;
    const oursScored = rows.filter((r) => scored(r.ours)).length;
    tableLines.push(`  ${rows.length} specs · native scored ${nativeScored}/${rows.length} · ours scored ${oursScored}/${rows.length}`);

    console.log("\n" + tableLines.join("\n"));

    expect(rows.length).toBe(selected.length);
  }, 1800000);
});
