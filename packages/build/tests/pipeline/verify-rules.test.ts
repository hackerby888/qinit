// `qinit verify` reports Qinit's own build rules even when the external verifier is not installed.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyContract } from "../../src";

const originalEnv = { QINIT_CACHE: process.env.QINIT_CACHE, QINIT_VERIFY: process.env.QINIT_VERIFY };
const dirs: string[] = [];

afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// An empty cache and no QINIT_VERIFY leave only PATH; a verifier there makes the tool-less shape untestable.
const toolOnPath = Bun.which("contractverify") !== null;

function contractWithBareDiv(): string {
    const dir = mkdtempSync(join(tmpdir(), "qinit-verify-rules-"));
    dirs.push(dir);
    process.env.QINIT_CACHE = join(dir, "cache");
    delete process.env.QINIT_VERIFY;
    const file = join(dir, "Ratio.h");
    writeFileSync(
        file,
        `
using namespace QPI;
struct Ratio : public ContractBase {
  struct StateData { uint64 last; };
  struct Read_input { uint64 a; uint64 b; };
  struct Read_output { uint64 q; };
  PUBLIC_FUNCTION(Read) { output.q = div(input.a, input.b); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`,
    );
    return file;
}

test.skipIf(toolOnPath)("a bare div fails verify without the external tool, and the tool still reads as absent", async () => {
    const file = contractWithBareDiv();

    const result = await verifyContract(file, "Ratio", { buildRules: { contractKind: "user" } });

    expect(result.available).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("QPI::div");
});

test.skipIf(toolOnPath)("without buildRules the same file is the plain skipped result builds rely on", async () => {
    const file = contractWithBareDiv();

    expect(await verifyContract(file, "Ratio")).toMatchObject({ available: false, ok: true, errors: [] });
    expect(await verifyContract(file, "Ratio", { buildRules: { contractKind: "user", buildRules: false } })).toMatchObject({ ok: true, errors: [] });
});
