import { CORE_PATH } from "../../../../test-utils/paths";
// Verifies the assembled header, manifest hash, and generated browser module.
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import { loadQpiHeader } from "../../src/index";
import { assembleQpiHeader, GENERATOR_VERSION, snapshotInputFiles } from "../../src/qpi-snapshot";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "../../src/generated/qpi-snapshot";

const CORE = CORE_PATH;
const coreOk = existsSync(join(CORE, "src", "contracts", "qpi.h"));
const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "core-snapshot.json"), "utf8"),
);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 n; };
  struct Bump_input { uint64 by; };
  struct Bump_output {};
  PUBLIC_PROCEDURE(Bump)
  {
    state.mut().n += input.by;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Bump, 1); }
};`;

describe.if(coreOk)("qpi snapshot assembly", () => {
  test("loadQpiHeader delegates to assembleQpiHeader byte-identically", () => {
    expect(assembleQpiHeader(CORE)).toBe(loadQpiHeader(CORE));
  });

  test("assembly is deterministic", () => {
    expect(assembleQpiHeader(CORE)).toBe(assembleQpiHeader(CORE));
  });

  test("input tracking follows the canonical split SDK layout", () => {
    const inputs = snapshotInputFiles(CORE);
    const wasmInputs = [
      CORE_WASM_HEADERS.shared.abiMetadata,
      CORE_WASM_HEADERS.shared.abiTypes,
      CORE_WASM_HEADERS.sdk.lhostImports,
      CORE_WASM_HEADERS.sdk.qpiForwarders,
      CORE_WASM_HEADERS.sdk.moduleStorage,
    ];
    for (const relativePath of wasmInputs) {
      expect(inputs).toContain(join(CORE, "src", relativePath));
    }
    expect(
      inputs
        .filter((path) => path.startsWith(join(CORE, "src", CORE_WASM_HEADERS.root)))
        .sort(),
    ).toEqual(wasmInputs.map((path) => join(CORE, "src", path)).sort());
  });

  test("non-core path throws instead of returning a stub", () => {
    expect(() => assembleQpiHeader("/nonexistent")).toThrow(/not a core checkout/);
  });
});

const browserModule = "../../src/browser";

describe("tracked snapshot + browser entry", () => {
  test("generated module embeds the assembly verbatim with a matching hash", async () => {
    if (coreOk) {
      expect(QPI_SNAPSHOT).toBe(assembleQpiHeader(CORE));
    }
    const hash = "sha256:" + createHash("sha256").update(QPI_SNAPSHOT).digest("hex");
    expect(QPI_SNAPSHOT_META.snapshotHash as string).toBe(hash);
    expect(QPI_SNAPSHOT_META.generatorVersion).toBe(GENERATOR_VERSION);
    expect(QPI_SNAPSHOT_META.coreCommit).toBe(manifest.core.commit);
  });

  test("browser entry compiles without a caller-provided qpiHeader", async () => {
    const browser = await import(browserModule);
    const res = await browser.compileContract({
      source: SOURCE,
      name: "SNAP",
      slot: 27,
      arenaSz: 1 << 20,
    });
    expect(
      res.diagnostics.filter((d: { severity: string }) => d.severity === "error"),
    ).toHaveLength(0);
    expect(res.wasm.byteLength).toBeGreaterThan(0);
    expect(res.idl.procedures.map((p: { name: string }) => p.name)).toContain("Bump");

    expect(browser.compilerInfo.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(browser.compilerInfo.protocolVersion).toBe(browser.COMPILER_PROTOCOL_VERSION);
    expect(browser.compilerInfo.qinitVersion.length).toBeGreaterThan(0);
    expect(browser.compilerInfo.coreCommit.length).toBeGreaterThan(0);
  });
});
