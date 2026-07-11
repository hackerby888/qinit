// Shared bridge for driving the upstream contract_qutil.cpp gtest corpus against deployable QUTIL+QX wasm. The runner (clang) is mode-independent;
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContractTesting } from "@qinit/engine";
import { compileContract, loadQpiHeader, type CompileResult } from "../src/index";
import { buildContract, buildCorpusRunner } from "@qinit/build";

export const CORE = "/home/kali/Projects/core-lite";
export const QUTIL_IDX = 4;
export const QX_IDX = 1;

export interface TR {
  name: string;
  passed: boolean;
  message: string;
}

export function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

function calleeIdlFrom(name: string, index: number, r: CompileResult) {
  const fns = Object.fromEntries(r.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }]));
  const procs = Object.fromEntries(r.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }]));
  return { name, index, functions: fns, procedures: procs };
}

// Phase 0: the clang runner wasm (test logic + a dead QUTIL copy for types). Built once, mode-independent.
export async function buildRunner(core: string): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "qutil-upstream-"));
  try {
    const built = await buildCorpusRunner({
      corpusPath: `${core}/test/contract_qutil.cpp`,
      contractPath: `${core}/src/contracts/QUtil.h`,
      name: "QUTIL",
      stateType: "QUTIL",
      slot: QUTIL_IDX,
      corePath: core,
      outDir: dir,
      arenaSz: 8 * 1024 * 1024,
    });
    if (!built.ok) throw new Error("runner build failed:\n" + (built.stderr ?? ""));
    return new Uint8Array(readFileSync(built.so!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Phase 1 (ours): QUTIL+QX compiled by our TS compiler. QUTIL gets QX's IDL + source so its
export async function buildContractsOurs(core: string): Promise<Record<number, Uint8Array>> {
  const headers = loadQpiHeader(core);
  const qutilSrc = readFileSync(`${core}/src/contracts/QUtil.h`, "utf8");
  const qxSrc = readFileSync(`${core}/src/contracts/Qx.h`, "utf8");

  const mineQx = await compileContract({ source: qxSrc, name: "QX", slot: QX_IDX, qpiHeader: headers, arenaSz: 8 * 1024 * 1024 });
  const callees = [calleeIdlFrom("QX", QX_IDX, mineQx)];
  const calleeSources = [{ name: "QX", source: qxSrc }];
  const mineQutil = await compileContract({ source: qutilSrc, name: "QUTIL", slot: QUTIL_IDX, qpiHeader: headers, arenaSz: 8 * 1024 * 1024, callees, calleeSources });

  const qxErrs = mineQx.diagnostics.filter((d) => d.severity === "error");
  const qutilErrs = mineQutil.diagnostics.filter((d) => d.severity === "error");
  if (qxErrs.length || qutilErrs.length) {
    const fmt = (label: string, ds: typeof qxErrs) => ds.map((d) => `  ${label} L${d.span.line}: ${d.message}`).join("\n");
    throw new Error("ours compile errors:\n" + fmt("QX", qxErrs) + (qxErrs.length && qutilErrs.length ? "\n" : "") + fmt("QUTIL", qutilErrs));
  }
  return { [QUTIL_IDX]: mineQutil.wasm, [QX_IDX]: mineQx.wasm };
}

// Phase 1 (native): QUTIL+QX built by clang (LITE_WASM_TU_BUILD) as plain deployable contract wasm — no testSource, so recipe.ts
export async function buildContractsNative(core: string): Promise<Record<number, Uint8Array>> {
  const dir = mkdtempSync(join(tmpdir(), "qutil-native-"));

  try {
    const qx = await buildContract({
      contractPath: `${core}/src/contracts/Qx.h`, name: "QX", stateType: "QX", slot: QX_IDX,
      corePath: core, outDir: dir, arenaSz: 8 * 1024 * 1024, skipVerify: true,
    });
    if (!qx.ok) {
      throw new Error("native QX build failed:\n" + (qx.stderr ?? "").split("\n").slice(-15).join("\n"));
    }

    const qutil = await buildContract({
      contractPath: `${core}/src/contracts/QUtil.h`, name: "QUTIL", stateType: "QUTIL", slot: QUTIL_IDX,
      corePath: core, outDir: dir, arenaSz: 8 * 1024 * 1024, skipVerify: true,
    });
    if (!qutil.ok) {
      throw new Error("native QUTIL build failed:\n" + (qutil.stderr ?? "").split("\n").slice(-15).join("\n"));
    }

    const qxBytes = new Uint8Array(readFileSync(qx.so!));
    const qutilBytes = new Uint8Array(readFileSync(qutil.so!));
    return { [QUTIL_IDX]: qutilBytes, [QX_IDX]: qxBytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Instantiate the runner wasm, bind the thost table to a fresh Sim with the contracts deployed, drive each test.
export async function runUpstream(runnerWasm: Uint8Array, contracts: Record<number, Uint8Array>): Promise<TR[]> {
  return runContractTesting(runnerWasm, contracts);
}
