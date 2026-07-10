// The snapshot pipeline: assembleQpiHeader is the single source of header text (loadQpiHeader delegates to it), the generator's output
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadQpiHeader } from "../src/index";
import { assembleQpiHeader, GENERATOR_VERSION } from "../src/qpi-snapshot";

const CORE = process.env.QINIT_CORE ?? "/home/kali/Projects/core-lite";
const coreOk = existsSync(join(CORE, "src", "contracts", "qpi.h"));
const genDir = join(import.meta.dir, "..", ".generated");
const genOk = existsSync(join(genDir, "qpi-snapshot.ts"));

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

  test("non-core path throws instead of returning a stub", () => {
    expect(() => assembleQpiHeader("/nonexistent")).toThrow(/not a core checkout/);
  });
});

// Computed specifiers: both modules exist only after generation — a literal import would fail typechecking on a checkout
const genModule = "../.generated/qpi-snapshot";
const browserModule = "../src/browser";

describe.if(genOk)("generated snapshot + browser entry", () => {
  test("generated module embeds the assembly verbatim with a matching hash", async () => {
    const gen = await import(genModule);
    if (coreOk) {
      expect(gen.QPI_SNAPSHOT).toBe(assembleQpiHeader(CORE));
    }
    const hash = "sha256:" + createHash("sha256").update(gen.QPI_SNAPSHOT).digest("hex");
    expect(gen.QPI_SNAPSHOT_META.snapshotHash as string).toBe(hash);
    expect(gen.QPI_SNAPSHOT_META.generatorVersion).toBe(GENERATOR_VERSION);
    expect(readFileSync(join(genDir, "qpi-snapshot.txt"), "utf8")).toBe(gen.QPI_SNAPSHOT);
  });

  test("browser entry compiles without a caller-provided qpiHeader", async () => {
    const browser = await import(browserModule);
    const res = await browser.compileContract({ source: SOURCE, name: "SNAP", slot: 27, arenaSz: 1 << 20 });
    expect(res.diagnostics.filter((d: { severity: string }) => d.severity === "error")).toHaveLength(0);
    expect(res.wasm.byteLength).toBeGreaterThan(0);
    expect(res.idl.procedures.map((p: { name: string }) => p.name)).toContain("Bump");

    expect(browser.compilerInfo.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(browser.compilerInfo.protocolVersion).toBe(browser.COMPILER_PROTOCOL_VERSION);
    expect(browser.compilerInfo.qinitVersion.length).toBeGreaterThan(0);
    expect(browser.compilerInfo.coreCommit.length).toBeGreaterThan(0);
  });
});
