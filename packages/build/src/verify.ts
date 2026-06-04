// Pre-compile protocol-rule check using the Qubic contract-verify tool (contractverify):
// a prebuilt native CppParser AST checker that enforces the qpi.h restrictions — no `#`,
// no ctor/dtor, no throw/try, no function pointers, no `[]` arrays / stack allocation,
// only allowed integer/id/Array IO types, etc. Source: Franziska-Mueller/qubic-contract-verify.
// Shipped like the node: a cached binary, not embedded in the dep-free qinit binary.
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
  const w = Bun.spawnSync(["sh", "-c", "command -v contractverify"]);
  if (w.exitCode === 0) { const p = new TextDecoder().decode(w.stdout).trim(); if (p) return p; }
  return null;
}

// The contract .h uses the CONTRACT_STATE(2)_TYPE macros (substituted at compile by the build
// wrapper). The verify tool parses raw source, so it needs the concrete names: a global struct
// deriving ContractBase named <name>, and state2 = <name>2. Substitute STATE2 first (longer).
function concretize(src: string, name: string): string {
  return src.replaceAll("CONTRACT_STATE2_TYPE", `${name}2`).replaceAll("CONTRACT_STATE_TYPE", name);
}

export async function verifyContract(file: string, name: string, opts?: { oracle?: boolean }): Promise<VerifyResult> {
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
  const errors = raw.split("\n").filter((l) => l.includes("[ ERROR ]")).map((l) => l.replace(/.*\[ ERROR \]\s*/, "").trim());
  return { available: true, ok: p.exitCode === 0, oracle, errors, raw, tool };
}
