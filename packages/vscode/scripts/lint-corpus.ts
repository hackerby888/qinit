// Real-corpus false-positive gate. Every DEPLOYED core contract is valid QPI, so the Tier-A linter
// must raise ZERO warning/error-severity findings on them — anything it does raise is a false positive.
// (info-level hints, e.g. `#if 0` dead-code in QUtil, are advisory and tolerated.)
//
// The deployed set is derived from core-lite's contract_def.h (`#include "contracts/X.h"`), minus the
// non-deployed test harnesses + the superseded Qswap_old. Run locally with QINIT_CORE, and in CI's
// `corpus` job (which checks out core-lite):
//   QINIT_CORE=/path/to/core-lite bun run packages/vscode/scripts/lint-corpus.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCore } from "@qinit/core/project";
import { scanQpi, scanLocals, scanLocalsForm, type QpiFinding } from "../src/lint/qpi-rules";
import { idlChecks } from "../src/lint/idl-checks";

// Registered in contract_def.h but NOT deployed QPI contracts: the header itself, the test-example
// harnesses (printf/#ifdef debug code), and the superseded Qswap (Qswap.h is the active one).
const DENY = new Set(["qpi.h", "Qswap_old.h", "TestExampleA.h", "TestExampleB.h", "TestExampleC.h", "TestExampleD.h"]);

export function deployedContracts(core: string): string[] {
  const def = join(core, "src", "contract_core", "contract_def.h");
  if (!existsSync(def)) return [];
  return [...readFileSync(def, "utf8").matchAll(/#include\s+"contracts\/([\w.]+\.h)"/g)]
    .map((m) => m[1])
    .filter((f) => !DENY.has(f));
}

// All warning/error-severity findings per deployed contract (info-level hints excluded).
export function lintCorpus(core: string): { file: string; findings: QpiFinding[] }[] {
  const dir = join(core, "src", "contracts");
  const out: { file: string; findings: QpiFinding[] }[] = [];
  for (const f of deployedContracts(core)) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    const findings = [...scanQpi(src), ...scanLocals(src), ...scanLocalsForm(src), ...idlChecks(src)]
      .filter((h) => h.severity !== "info");
    out.push({ file: f, findings });
  }
  return out;
}

if (import.meta.main) {
  let core: string;
  try { core = resolveCore(process.env.QINIT_CORE); } catch (e: any) {
    console.error("no core headers:", String(e?.message ?? e), "— set QINIT_CORE or run `qinit node run`");
    process.exit(2);
  }
  const results = lintCorpus(core);
  let bad = 0;
  for (const r of results) {
    if (!r.findings.length) continue;
    bad += r.findings.length;
    const dir = join(core, "src", "contracts");
    const src = readFileSync(join(dir, r.file), "utf8");
    console.log(`FAIL ${r.file}:`);
    for (const h of r.findings.slice(0, 8)) {
      const line = src.slice(0, h.offset).split("\n").length;
      console.log(`   L${line} ${h.rule}: ${JSON.stringify(src.slice(h.offset, h.offset + 40).replace(/\n/g, "\\n"))}`);
    }
  }
  console.log(`\nlint-corpus: ${results.length} deployed contracts scanned, ${bad} warning/error findings`);
  process.exit(bad === 0 ? 0 : 1);
}
