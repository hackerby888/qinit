import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCoreDir } from "@qinit/core/project";
import { lintCorpus, deployedContracts } from "../../scripts/lint-corpus";

let core: string | undefined;
try {
    core = resolveCoreDir(process.env.QINIT_CORE);
} catch {
    core = undefined;
}
const hasCore = !!core && existsSync(join(core, "src", "contract_core", "contract_def.h"));

// lints every deployed core contract: about 6 s on a slow macos runner, past bun's 5 s default.
test.if(hasCore)("no warn/error linter findings across the deployed core contracts", () => {
    const offenders = lintCorpus(core!)
        .filter((r) => r.findings.length)
        .map((r) => ({ file: r.file, rules: r.findings.map((f) => f.code) }));
    expect(offenders).toEqual([]);
}, 60_000);

test.if(hasCore)("the deployed corpus is non-trivial (sanity that we actually scanned contracts)", () => {
    expect(deployedContracts(core!).length).toBeGreaterThan(15);
});
