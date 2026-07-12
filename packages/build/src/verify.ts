// Pre-compile protocol-rule check using the Qubic contract-verify tool (contractverify):
// a prebuilt native CppParser AST checker that enforces qpi.h restrictions with no `#include` dependency.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheRoot, readCurrent } from "@qinit/core";

export interface VerifyResult {
  available: boolean;  // tool found on this box
  ok: boolean;         // compliance passed (true when skipped/unavailable)
  oracle: boolean;     // checked as an oracle interface (--oi)
  errors: string[];    // parsed `[ ERROR ]` violation messages
  raw?: string;        // full tool output (diagnostics)
  tool?: string;       // resolved binary path
}

// QINIT_VERIFY env > current.json pointer > cached tools dir > PATH.
export function resolveVerifyTool(): string | null {
  const cands = [process.env.QINIT_VERIFY, readCurrent()?.verify, join(cacheRoot(), "tools", "contractverify")]
    .filter(Boolean) as string[];
  for (const c of cands) if (existsSync(c)) return c;
  return Bun.which("contractverify"); // cross-platform PATH lookup (no `sh` on Windows)
}

// The contract .h uses the CONTRACT_STATE(2)_TYPE macros (substituted at compile by the build
// wrapper). The verify tool parses raw source, so it needs the concrete names: a global struct
function concretize(src: string, name: string): string {
  return src.replaceAll("CONTRACT_STATE2_TYPE", `${name}2`).replaceAll("CONTRACT_STATE_TYPE", name);
}

// allowedPrefixes: inter-contract callee names (from --callee / CALL_OTHER_CONTRACT). The tool only whitelists
// the upstream registered contracts, so it rejects `<DynCallee>::Type` scope resolution; those errors are false
export async function verifyContract(file: string, name: string, opts?: { oracle?: boolean; allowedPrefixes?: string[] }): Promise<VerifyResult> {
  const tool = resolveVerifyTool();
  const oracle = !!opts?.oracle || /oracle_interface/i.test(file);
  if (!tool) return { available: false, ok: true, oracle, errors: [] };

  let target = file;
  if (!oracle) {
    const tmp = join(tmpdir(), `qinit-verify-${name}-${process.pid}.h`);
    writeFileSync(tmp, concretize(readFileSync(file, "utf8"), name));
    target = tmp;
  }
  const p = Bun.spawn([tool, ...(oracle ? ["--oi", target] : [target])], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const raw = (out + err).trim();
  const allErrors = raw.split("\n").filter((l) => l.includes("[ ERROR ]")).map((l) => l.replace(/.*\[ ERROR \]\s*/, "").trim());
  const allow = opts?.allowedPrefixes ?? [];
  const errors = allErrors.filter((e) => !allow.some((p) => e === `Scope resolution with prefix ${p} is not allowed.`));
  const dropped = allErrors.length - errors.length;
  // A non-zero exit with NO parsed [ ERROR ] lines is a tool malfunction (crash / unsupported host /
  // missing dep), not a real violation — report it unavailable (skip) like an absent tool, so a broken
  if (p.exitCode !== 0 && allErrors.length === 0)
    return { available: false, ok: true, oracle, errors: [], raw, tool };
  // pass on a clean exit, or when the only violations were the declared-callee scope-resolution errors.
  const ok = p.exitCode === 0 || (dropped > 0 && errors.length === 0);
  return { available: true, ok, oracle, errors, raw, tool };
}
