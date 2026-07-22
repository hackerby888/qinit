import { CORE_PATH, QINIT_ROOT } from "../../../test-utils/paths";
// Compiles representative fixtures and reports diagnostics and Wasm size.
import { readFileSync } from "node:fs";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);
const FIX = QINIT_ROOT + "/fixtures";

const targets: [string, string][] = [
  ["Counter", `${FIX}/Counter.h`],
  ["Bank", `${FIX}/Bank.h`],
  ["Token", `${FIX}/Token.h`],
];

for (const [name, path] of targets) {
  const source = readFileSync(path, "utf8");
  try {
    const result = await compileContract({
      source,
      name,
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const warnings = result.diagnostics.filter(
      (diagnostic) => diagnostic.severity === "warning",
    );
    console.log(
      `\n=== ${name} === wasm=${result.wasm.byteLength}b errors=${errors.length} warnings=${warnings.length}`,
    );
    for (const error of errors.slice(0, 10)) {
      console.log(`  ERROR ${error.span.line}: ${error.message}`);
    }
    for (const warning of warnings.slice(0, 20)) {
      console.log(`  warn ${warning.span.line}: ${warning.message}`);
    }
  } catch (e: any) {
    console.log(`\n=== ${name} === THREW: ${e.message}`);
    if (e.stack) {
      console.log(e.stack.split("\n").slice(0, 6).join("\n"));
    }
  }
}
