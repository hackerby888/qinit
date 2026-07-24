import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Drives the upstream QUTIL gtests against deployable QUTIL and QX Wasm.
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContractTesting } from "@qinit/engine";
import {
  compileContract,
  loadQpiHeader,
  type CompileResult,
  type ContractIdl,
} from "../../src/index";
import { buildContract, buildCorpusRunner } from "@qinit/build";

export const CORE = CORE_PATH;
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

function calleeIdlFrom(name: string, slot: number, result: CompileResult): ContractIdl {
  if (!result.idl) {
    throw new Error(`successful ${name} compile returned no IDL`);
  }
  return {
    ...result.idl,
    name,
    slot,
  };
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
    if (!built.ok) {
      throw new Error("runner build failed:\n" + (built.stderr ?? ""));
    }
    return new Uint8Array(readFileSync(built.so!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Compile QUTIL and QX with the TS compiler, including QX as a callee.
export async function buildContractsOurs(core: string): Promise<Record<number, Uint8Array>> {
  const headers = loadQpiHeader(core);
  const qutilSrc = readFileSync(`${core}/src/contracts/QUtil.h`, "utf8");
  const qxSrc = readFileSync(`${core}/src/contracts/Qx.h`, "utf8");

  const mineQx = await compileContract({
    source: qxSrc,
    name: "QX",
    slot: QX_IDX,
    qpiHeader: headers,
    arenaSz: 8 * 1024 * 1024,
  });
  const callees = [calleeIdlFrom("QX", QX_IDX, mineQx)];
  const calleeSources = [{ name: "QX", source: qxSrc }];
  const mineQutil = await compileContract({
    source: qutilSrc,
    name: "QUTIL",
    slot: QUTIL_IDX,
    qpiHeader: headers,
    arenaSz: 8 * 1024 * 1024,
    callees,
    calleeSources,
  });

  const qxErrs = mineQx.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
  const qutilErrs = mineQutil.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
  if (qxErrs.length || qutilErrs.length) {
    const fmt = (label: string, ds: typeof qxErrs) =>
      ds.map((d) => `  ${label} L${d.span.line}: ${d.message}`).join("\n");
    throw new Error(
      "ours compile errors:\n" +
        fmt("QX", qxErrs) +
        (qxErrs.length && qutilErrs.length ? "\n" : "") +
        fmt("QUTIL", qutilErrs),
    );
  }
  return { [QUTIL_IDX]: mineQutil.wasm, [QX_IDX]: mineQx.wasm };
}

// Compile deployable QUTIL and QX Wasm with native Clang.
export async function buildContractsNative(core: string): Promise<Record<number, Uint8Array>> {
  const dir = mkdtempSync(join(tmpdir(), "qutil-native-"));

  try {
    const qx = await buildContract({
      contractPath: `${core}/src/contracts/Qx.h`,
      name: "QX",
      stateType: "QX",
      slot: QX_IDX,
      corePath: core,
      outDir: dir,
      arenaSz: 8 * 1024 * 1024,
      skipVerify: true,
    });
    if (!qx.ok) {
      throw new Error(
        "native QX build failed:\n" + (qx.stderr ?? "").split("\n").slice(-15).join("\n"),
      );
    }

    const qutil = await buildContract({
      contractPath: `${core}/src/contracts/QUtil.h`,
      name: "QUTIL",
      stateType: "QUTIL",
      slot: QUTIL_IDX,
      corePath: core,
      outDir: dir,
      arenaSz: 8 * 1024 * 1024,
      skipVerify: true,
    });
    if (!qutil.ok) {
      throw new Error(
        "native QUTIL build failed:\n" + (qutil.stderr ?? "").split("\n").slice(-15).join("\n"),
      );
    }

    const qxBytes = new Uint8Array(readFileSync(qx.so!));
    const qutilBytes = new Uint8Array(readFileSync(qutil.so!));
    return { [QUTIL_IDX]: qutilBytes, [QX_IDX]: qxBytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Run the shared test runner against a deployed contract set.
export async function runUpstream(
  runnerWasm: Uint8Array,
  contracts: Record<number, Uint8Array>,
): Promise<TR[]> {
  return runContractTesting(runnerWasm, contracts);
}
