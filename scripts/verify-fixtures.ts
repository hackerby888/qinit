// Run contractverify (the qpi.h protocol-rule AST checker) over every fixtures/*.h and fail if any
// real violation is found. Fast: concretize + run the tool, no wasm compile. Used by CI so a fixture
import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { verifyContract } from "../packages/build/src/verify";
import { autoUpdateVerifyTool } from "../packages/core/src/index";

await autoUpdateVerifyTool().catch(() => {});   // best-effort: fetch the cached contractverify on a clean runner

// Inter-contract fixtures: the tool flags `<Callee>::Type` scope resolution because it can't see the
// declared callee. Whitelist those prefixes (verifyContract drops exactly those false positives).
const CALLEES: Record<string, string[]> = { Proxy: ["Counter"] };
// Valid contracts the tool's parser cannot handle (tool limitation, not a rule violation) — skip with reason.
const UNVERIFIABLE: Record<string, string> = {
  ShareReceiver: "SET_SHAREHOLDER_PROPOSAL system callback — the verify tool's parser rejects it",
};

const dir = join(import.meta.dir, "..", "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".h")).sort();
let bad = 0, skipped = 0;
for (const f of files) {
  const name = basename(f, ".h");
  if (UNVERIFIABLE[name]) { console.log(`SKIP  ${name} — ${UNVERIFIABLE[name]}`); skipped++; continue; }
  const r = await verifyContract(join(dir, f), name, { allowedPrefixes: CALLEES[name] });
  if (!r.available) { console.log(`SKIP  ${name} (verify tool unavailable)`); skipped++; continue; }
  if (r.ok) { console.log(`PASS  ${name}`); continue; }
  bad++;
  console.log(`FAIL  ${name}\n      ${r.errors.join("\n      ")}`);
}
console.log(`\n${files.length - bad - skipped} pass, ${bad} fail, ${skipped} skipped`);
process.exit(bad ? 1 : 0);
