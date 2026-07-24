// Build a contract .h -> wasm with the in-process TS compiler (@qinit/compile) — no clang, no toolchain.
// Shared by build, deploy, dev, and test when `qinit compiler local` is selected.
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  compileContract,
  DiagnosticSeverity,
  loadQpiHeader,
  type ContractIdl,
} from "@qinit/compile";
import {
  analyzeContract,
  type SourceAnalysisResult,
} from "@qinit/compile/analyzer";

export interface LocalBuildResult {
  ok: boolean;
  so?: string; // path to the emitted .wasm
  size?: number;
  idl?: ContractIdl; // rich idl (build's extractIdl) for downstream tooling
  stderr?: string;
  // Not produced by the local path (kept optional so this unions cleanly with @qinit/build's BuildResult
  // wherever the deploy pipeline reads a build result). hash falls back to k12 of the wasm bytes downstream.
  hash?: string;
  idlError?: string;
  debugWasm?: string;
  linesJson?: string;
}

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
    name: callee.name,
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

export async function compileLocal(o: {
  contractPath: string;
  name: string;
  slot: number;
  core: string;
  outDir: string;
  dynCallees?: Record<string, { header: string; index: number }>;
}): Promise<LocalBuildResult> {
  const qpiHeader = loadQpiHeader(o.core);
  if (!qpiHeader) {
    return {
      ok: false,
      stderr: "cannot load qpi.h — set QINIT_CORE or pass --core <core-lite checkout>",
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
    name: o.name,
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
  const so = join(o.outDir, `${o.name}.wasm`);
  writeFileSync(so, Buffer.from(r.wasm));
  return {
    ok: true,
    so,
    size: statSync(so).size,
    idl: r.idl,
    stderr: warns.length ? warns.map((d) => `warning: ${d.message}`).join("\n") : undefined,
  };
}
