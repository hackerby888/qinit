// Run contractverify over every fixture and fail on real protocol violations.
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { verifyContract } from "../packages/build/src/verify";
import { autoUpdateVerifyTool } from "../packages/core/src/index";

// Best effort: fetch contractverify on a clean runner.
await autoUpdateVerifyTool().catch(() => {});

// Inter-contract fixtures: the tool flags `<Callee>::Type` scope resolution because it can't see the
// declared callee. Whitelist those prefixes (verifyContract drops exactly those false positives).
const CALLEES: Record<string, string[]> = {
  Proxy: ["Counter"],
  QpiDual: ["QpiDualCallee"],
};
// Fixtures that intentionally exercise non-protocol paths, plus known verifier parser limitations.
const UNVERIFIABLE: Record<string, string> = {
  RandomDual: "deliberately exercises the compiler's pointer-form _rdrand intrinsics, which protocol contracts forbid",
  ShareReceiver: "SET_SHAREHOLDER_PROPOSAL system callback — the verify tool's parser rejects it",
  Trap: "deliberately uses forbidden raw division to exercise Wasm trap isolation",
};

const dir = join(import.meta.dir, "..", "fixtures");
const files = readdirSync(dir).filter((file) => file.endsWith(".h")).sort();
let failed = 0;
let skipped = 0;
for (const file of files) {
  const name = basename(file, ".h");
  if (UNVERIFIABLE[name]) {
    console.log(`SKIP  ${name} — ${UNVERIFIABLE[name]}`);
    skipped++;
    continue;
  }

  const result = await verifyContract(join(dir, file), name, {
    allowedPrefixes: CALLEES[name],
  });
  if (!result.available) {
    console.log(`SKIP  ${name} (verify tool unavailable)`);
    skipped++;
    continue;
  }
  if (result.ok) {
    console.log(`PASS  ${name}`);
    continue;
  }

  failed++;
  console.log(`FAIL  ${name}\n      ${result.errors.join("\n      ")}`);
}
console.log(`\n${files.length - failed - skipped} pass, ${failed} fail, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
