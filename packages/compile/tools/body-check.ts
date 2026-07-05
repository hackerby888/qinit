// Quick body-codegen smoke: compile fixtures, report diagnostics + wasm size. wabt validates the WAT,
// so a non-empty wasm with no error diagnostics means the emitted module is at least well-formed.
import { readFileSync } from "node:fs";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);
const FIX = "/home/kali/Projects/Qinit/fixtures";

const targets: [string, string][] = [
  ["Counter", `${FIX}/Counter.h`],
  ["Bank", `${FIX}/Bank.h`],
  ["Token", `${FIX}/Token.h`],
];

for (const [name, path] of targets) {
  const source = readFileSync(path, "utf8");
  try {
    const r = await compileContract({ source, name, slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    const errs = r.diagnostics.filter((d) => d.severity === "error");
    const warns = r.diagnostics.filter((d) => d.severity === "warning");
    console.log(`\n=== ${name} === wasm=${r.wasm.byteLength}b errors=${errs.length} warnings=${warns.length}`);
    for (const e of errs.slice(0, 10)) console.log(`  ERROR ${e.span.line}: ${e.message}`);
    for (const w of warns.slice(0, 20)) console.log(`  warn ${w.span.line}: ${w.message}`);
  } catch (e: any) {
    console.log(`\n=== ${name} === THREW: ${e.message}`);
    if (e.stack) console.log(e.stack.split("\n").slice(0, 6).join("\n"));
  }
}
