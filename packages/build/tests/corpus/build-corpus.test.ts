import { CORE_PATH } from "../../../../test-utils/paths";
// Compile the upstream QUTIL corpus to verify its include redirect and Wasm test harness.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpusRunner } from "../../src/index";

const CORE = CORE_PATH;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

test("QUTIL corpus compiles verbatim against the qinit harness header", async () => {
  if (!wasiAvailable()) {
    console.log("  (wasi-sdk clang not found — skipping)");
    return;
  }

  const outDir = mkdtempSync(join(tmpdir(), "qutil-corpus-"));

  const built = await buildCorpusRunner({
    corpusPath: join(CORE, "test", "contract_qutil.cpp"),
    contractPath: join(CORE, "src", "contracts", "QUtil.h"),
    name: "QUTIL",
    stateType: "QUTIL",
    slot: 4,
    corePath: CORE,
    outDir,
  });

  if (!built.ok) {
    console.error("Build stderr:\n" + built.stderr);
  }

  expect(built.ok).toBe(true);
}, 300000);
