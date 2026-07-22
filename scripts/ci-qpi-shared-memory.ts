// Run imported-memory suites that cannot use the ordinary shadow-state harness.
import { rmSync } from "node:fs";
import { runCorpus } from "../packages/cli/src/corpus-run";

const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");

for (const name of ["PULSE", "QEARN"]) {
  const scratch = `/tmp/qinit-shared-${name.toLowerCase()}`;
  rmSync(scratch, { recursive: true, force: true });
  const run = await runCorpus({
    name,
    core,
    backend: "local",
    scratch,
    onPhase: (phase) => console.log(`[${name}] ${phase}`),
  });
  const failed = run.results.filter((result) => !result.passed);
  if (!run.found || !run.hasCorpus || !run.runnerOk || !run.heavy || failed.length) {
    const details = failed
      .slice(0, 8)
      .map((result) => `${result.name}: ${result.message}`)
      .join("; ");
    throw new Error(
      `${name} shared-memory gate failed: ${run.buildError ?? details ?? "invalid corpus result"}`,
    );
  }
  console.log(`[${name}] SHARED OK — ${run.results.length}/${run.results.length} tests passed`);
}
