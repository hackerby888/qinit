// Build a contract .h -> wasm with the in-process TS compiler (@qinit/compiler) — no clang, no toolchain.
// Shared by build, deploy, dev, and test when the TypeScript compiler is selected.
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  compileContract,
  DiagnosticSeverity,
  loadQpiHeader,
  type ContractIdl,
} from "@qinit/compiler";
import {
  analyzeContract,
  type SourceAnalysisResult,
} from "@qinit/compiler/analyzer";
import type { ContractBuildResult } from "@qinit/build";
import { k12Hex } from "@qinit/core";

export type TypeScriptContractBuildResult = ContractBuildResult;

interface DynamicCalleeSource {
  name: string;
  slot: number;
  source: string;
}

function analyzeCallee(
  callee: DynamicCalleeSource,
  allCallees: DynamicCalleeSource[],
  qpiHeader: string,
): SourceAnalysisResult {
  return analyzeContract({
    source: callee.source,
    contractName: callee.name,
    slot: callee.slot,
    qpiHeader,
    calleeSources: allCallees
      .filter((item) => item.name !== callee.name)
      .map(({ name, slot, source }) => ({ name, slot, source })),
  });
}

function requireCalleeIdl(
  name: string,
  result: SourceAnalysisResult,
): ContractIdl | string {
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR,
  );
  if (errors.length > 0) {
    return `callee ${name}: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`;
  }
  if (!result.idl) {
    return `callee ${name}: compiler did not produce IDL`;
  }
  return result.idl;
}

export async function buildContractWithTypeScript(o: {
  contractPath: string;
  name: string;
  slot: number;
  core: string;
  outDir: string;
  dynCallees?: Record<string, { header: string; index: number }>;
}): Promise<TypeScriptContractBuildResult> {
  const qpiHeader = loadQpiHeader(o.core);
  if (!qpiHeader) {
    return {
      ok: false,
      stderr: "cannot load qpi.h — set QINIT_CORE or pass --core-dir <core-lite checkout>",
    };
  }
  const source = readFileSync(o.contractPath, "utf8");

  const dynamicCallees = Object.entries(o.dynCallees ?? {}).map(
    ([name, { header, index }]) => ({
      name,
      slot: index,
      source: readFileSync(header, "utf8"),
    }),
  );

  const callees: ContractIdl[] = [];
  for (const callee of dynamicCallees) {
    const analyzed = analyzeCallee(callee, dynamicCallees, qpiHeader);
    const idl = requireCalleeIdl(callee.name, analyzed);
    if (typeof idl === "string") {
      return { ok: false, stderr: idl };
    }
    callees.push(idl);
  }

  const calleeSources = dynamicCallees.map(({ name, slot, source }) => ({
    name,
    slot,
    source,
  }));
  const r = await compileContract({
    source,
    contractName: o.name,
    slot: o.slot,
    qpiHeader,
    callees: callees.length ? callees : undefined,
    calleeSources: calleeSources.length ? calleeSources : undefined,
  });
  const errs = r.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.ERROR,
  );
  if (errs.length) {
    return { ok: false, stderr: errs.map((d) => `error: ${d.message}`).join("\n") };
  }
  if (!r.idl) {
    return { ok: false, stderr: "compiler did not produce IDL" };
  }

  // Surface non-fatal warnings instead of dropping them; the build still succeeds.
  const warns = r.diagnostics.filter(
    (d) => d.severity === DiagnosticSeverity.WARNING,
  );

  mkdirSync(o.outDir, { recursive: true });
  const wasmPath = join(o.outDir, `${o.name}.wasm`);
  writeFileSync(wasmPath, Buffer.from(r.wasm));
  return {
    ok: true,
    wasmPath,
    wasmSizeBytes: statSync(wasmPath).size,
    wasmK12DigestHex: await k12Hex(r.wasm),
    idl: r.idl,
    stderr: warns.length ? warns.map((d) => `warning: ${d.message}`).join("\n") : undefined,
  };
}
