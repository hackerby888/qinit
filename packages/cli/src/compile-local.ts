// Build a contract .h -> wasm with the in-process TS compiler (@qinit/compile) — no clang, no toolchain.
// Shared by build, deploy, dev, and test when `qinit compiler local` is selected.
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compileContract, loadQpiHeader } from "@qinit/compile";
import { extractIdl, type ContractIdl } from "@qinit/build";

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

  // Inter-contract callees: compile each dep first for its type info (inputType/sizes) so the caller's
  // CALL/INVOKE_OTHER_CONTRACT sites wire to the right host-call signature (mirrors corpus-run's oursWasms).
  const callees: any[] = [];
  const calleeSources: Array<{ name: string; source: string }> = [];
  for (const [cname, { header, index }] of Object.entries(o.dynCallees ?? {})) {
    const dsrc = readFileSync(header, "utf8");
    const dr = await compileContract({ source: dsrc, name: cname, slot: index, qpiHeader });
    const derr = dr.diagnostics.filter((d) => d.severity === "error");
    if (derr.length) {
      return { ok: false, stderr: `callee ${cname}: ` + derr.map((d) => d.message).join("; ") };
    }
    callees.push({
      name: cname,
      index,
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
    calleeSources.push({ name: cname, source: dsrc });
  }

  const r = await compileContract({
    source,
    name: o.name,
    slot: o.slot,
    qpiHeader,
    callees: callees.length ? callees : undefined,
    calleeSources: calleeSources.length ? calleeSources : undefined,
  });
  const errs = r.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) {
    return { ok: false, stderr: errs.map((d) => `error: ${d.message}`).join("\n") };
  }

  // Surface non-fatal warnings instead of dropping them; the build still succeeds.
  const warns = r.diagnostics.filter((d) => d.severity === "warning");

  mkdirSync(o.outDir, { recursive: true });
  const so = join(o.outDir, `${o.name}.wasm`);
  writeFileSync(so, Buffer.from(r.wasm));
  return {
    ok: true,
    so,
    size: statSync(so).size,
    idl: extractIdl(source, o.name),
    stderr: warns.length ? warns.map((d) => `warning: ${d.message}`).join("\n") : undefined,
  };
}
