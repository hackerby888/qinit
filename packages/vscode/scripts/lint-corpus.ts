import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCore } from "@qinit/core/project";
import { scanQpi, scanLocals, scanLocalsForm, type QpiFinding } from "../src/lint/qpi-rules";
import { idlChecks } from "../src/lint/idl-checks";

const DENY = new Set([
  "qpi.h",
  "Qswap_old.h",
  "TestExampleA.h",
  "TestExampleB.h",
  "TestExampleC.h",
  "TestExampleD.h",
]);

export function deployedContracts(core: string): string[] {
  const def = join(core, "src", "contract_core", "contract_def.h");
  if (!existsSync(def)) return [];
  return [...readFileSync(def, "utf8").matchAll(/#include\s+"contracts\/([\w.]+\.h)"/g)]
    .map((match) => match[1])
    .filter((file) => !DENY.has(file));
}

export function lintCorpus(core: string): { file: string; findings: QpiFinding[] }[] {
  const dir = join(core, "src", "contracts");
  const results: { file: string; findings: QpiFinding[] }[] = [];
  for (const file of deployedContracts(core)) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      continue;
    }
    const source = readFileSync(path, "utf8");
    const findings = [
      ...scanQpi(source),
      ...scanLocals(source),
      ...scanLocalsForm(source),
      ...idlChecks(source),
    ].filter((finding) => finding.severity !== "info");
    results.push({ file, findings });
  }
  return results;
}

if (import.meta.main) {
  let core: string;
  try {
    core = resolveCore(process.env.QINIT_CORE);
  } catch (error: any) {
    console.error("no core headers:", String(error?.message ?? error), "— set QINIT_CORE");
    process.exit(2);
  }
  const results = lintCorpus(core);
  let failures = 0;
  for (const result of results) {
    if (!result.findings.length) {
      continue;
    }
    failures += result.findings.length;
    const dir = join(core, "src", "contracts");
    const source = readFileSync(join(dir, result.file), "utf8");
    console.log(`FAIL ${result.file}:`);
    for (const finding of result.findings.slice(0, 8)) {
      const line = source.slice(0, finding.offset).split("\n").length;
      const excerpt = source
        .slice(finding.offset, finding.offset + 40)
        .replace(/\n/g, "\\n");
      console.log(`   L${line} ${finding.rule}: ${JSON.stringify(excerpt)}`);
    }
  }
  console.log(
    `\nlint-corpus: ${results.length} deployed contracts scanned, ${failures} warning/error findings`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
