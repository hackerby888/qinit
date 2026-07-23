import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanCallees, type DynCallees } from "@qinit/build/intercontract";
import { generateClangdConfig } from "../src/clangd-config";
import { clangdErrorLines } from "../src/clangd-diag";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLANGD = process.env.CLANGD ?? "clangd";
const requested = process.argv.slice(2);
const core =
  process.env.QPI_VSCODE_HEADERS ??
  resolve(import.meta.dir, "..", "resources", "core-headers");
if (!existsSync(join(core, "src", "contracts", "qpi.h"))) {
  console.error("bundled QPI headers are missing — run `bun run prepare:headers`");
  process.exit(2);
}

const REAL: Record<string, string> = { QX: "Qx.h", QEARN: "Qearn.h", QUTIL: "QUtil.h", RANDOM: "Random.h" };

function entryFor(name: string): { name: string; path: string } | null {
  const fixture = join(REPO_ROOT, "fixtures", name + ".h");
  if (existsSync(fixture)) {
    return { name, path: fixture };
  }
  const real = REAL[name.toUpperCase()];
  if (real) {
    const contractPath = join(core, "src", "contracts", real);
    if (existsSync(contractPath)) {
      return { name, path: contractPath };
    }
  }
  return null;
}

const names = requested.length
  ? requested
  : ["Counter", "Token", "Bank", "Proxy", "Logger", ...Object.keys(REAL)];
const entries = names
  .map(entryFor)
  .filter((entry): entry is { name: string; path: string } => entry !== null);

function siblingCallees(source: string): DynCallees {
  const callees: DynCallees = {};
  for (const callee of scanCallees(source)) {
    const sibling = join(REPO_ROOT, "fixtures", callee + ".h");
    if (existsSync(sibling)) {
      callees[callee] = { header: sibling, index: 1 };
    }
  }
  return callees;
}

console.log(`headers:   ${core}`);
console.log(`clangd:    ${CLANGD}`);
console.log(`contracts: ${entries.map((entry) => entry.name).join(", ")}\n`);

let failures = 0;
for (const { name, path: contractPath } of entries) {
  const workspace = mkdtempSync(join(tmpdir(), "qpi-gate-"));
  try {
    const dynCallees = siblingCallees(readFileSync(contractPath, "utf8"));
    const config = generateClangdConfig({
      contractPath,
      corePath: core,
      dataRoot: workspace,
      workspaceRoot: workspace,
      name,
      dynCallees,
    });
    const child = Bun.spawnSync(
      [
        CLANGD,
        `--check=${config.contractFile}`,
        `--compile-commands-dir=${config.dir}`,
        "--log=error",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const log = (child.stdout?.toString() ?? "") + (child.stderr?.toString() ?? "");
    const errorLines = clangdErrorLines(log);
    const passed = errorLines.length === 0;
    const callees = Object.keys(dynCallees);
    console.log(
      `${passed ? "PASS" : "FAIL"}  ${name.padEnd(10)} (${errorLines.length} errors)${callees.length ? `  [callees: ${callees.join(", ")}]` : ""}`,
    );
    if (!passed) {
      failures++;
      const shown = [
        ...new Set(errorLines.map((line) => line.replace(/^E\[[^\]]*\]\s*/, "").trim())),
      ].slice(0, 30);
      console.log(shown.map((line) => "      " + line).join("\n"));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

console.log(
  `\n${failures === 0 ? `GATE: PASS — clangd resolves all ${entries.length} contracts` : `GATE: FAIL (${failures}/${entries.length})`}`,
);
process.exit(failures === 0 ? 0 : 1);
