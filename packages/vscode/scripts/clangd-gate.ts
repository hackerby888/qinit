// Verify that clangd resolves fixture and core contracts without C++ errors.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCore, wasiSdkPaths } from "@qinit/core/project";
import { scanCallees, type DynCallees } from "@qinit/build/intercontract";
import { generateClangdConfig } from "../src/clangd-config";
import { clangdErrorLines } from "../src/clangd-diag";

const REPO_ROOT = resolve(import.meta.dir, "../../.."); // packages/vscode/scripts -> repo root
const CLANGD = process.env.CLANGD ?? "clangd";
const requested = process.argv.slice(2);

const core = resolveCore(process.env.QINIT_CORE);
const sdk = wasiSdkPaths();
const wasiClang = process.env.WASM_CLANG ?? sdk?.clang;
const wasiSysroot = process.env.WASI_SYSROOT ?? sdk?.sysroot;
if (!wasiClang) {
  console.error("no wasi-sdk — run `qinit node run` (or set WASM_CLANG/WASI_SYSROOT)");
  process.exit(2);
}

// Real deployed contracts cover varied QPI features.
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

// Resolve sibling fixture callees without a running node.
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

console.log(`core:       ${core}`);
console.log(`wasi clang: ${wasiClang}`);
console.log(`clangd:     ${CLANGD}`);
console.log(`contracts:  ${entries.map((entry) => entry.name).join(", ")}\n`);

let failures = 0;
for (const { name, path: contractPath } of entries) {
  const workspace = mkdtempSync(join(tmpdir(), "qpi-gate-"));
  try {
    const dynCallees = siblingCallees(readFileSync(contractPath, "utf8"));
    const config = generateClangdConfig({
      contractPath,
      corePath: core,
      wasiClang,
      wasiSysroot,
      workspaceRoot: workspace,
      name,
      dynCallees,
    });
    const child = Bun.spawnSync(
      [
        CLANGD,
        `--check=${config.contractFile}`,
        `--compile-commands-dir=${config.dir}`,
        `--query-driver=${wasiClang}`,
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
