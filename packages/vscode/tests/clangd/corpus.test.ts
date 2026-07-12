import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCore } from "@qinit/core/project";
import { lintCorpus, deployedContracts } from "../../scripts/lint-corpus";

// Real-corpus false-positive gate (runs when a core-lite checkout is resolvable: QINIT_CORE locally,
// or the CI corpus job). Deployed contracts are valid QPI → the linter must raise 0 warn/error findings.
let core: string | undefined;
try { core = resolveCore(process.env.QINIT_CORE); } catch { core = undefined; }
const hasCore = !!core && existsSync(join(core, "src", "contract_core", "contract_def.h"));

test.if(hasCore)("no warn/error linter findings across the deployed core contracts", () => {
  const offenders = lintCorpus(core!)
    .filter((r) => r.findings.length)
    .map((r) => ({ file: r.file, rules: r.findings.map((f) => f.rule) }));
  expect(offenders).toEqual([]);
});

test.if(hasCore)("the deployed corpus is non-trivial (sanity that we actually scanned contracts)", () => {
  expect(deployedContracts(core!).length).toBeGreaterThan(15);
});
