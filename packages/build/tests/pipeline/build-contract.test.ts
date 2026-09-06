import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang, buildContractWithTypeScript } from "../../src";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const FORBIDDEN_PUBLIC_TYPES = [
    ["LinkedList", "LinkedList<uint64, 8>"],
    ["HashMap", "HashMap<id, uint64, 8>"],
    ["HashSet", "HashSet<id, 8>"],
    ["Collection", "Collection<uint64, 8>"],
] as const;

for (const [name, declaration] of FORBIDDEN_PUBLIC_TYPES) {
    test(`skipVerify still rejects public ${name} before Clang`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "qinit-complex-type-gate-"));
        const contractPath = join(directory, "Unsafe.h");
        writeFileSync(
            contractPath,
            `
using namespace QPI;
struct Unsafe : public ContractBase {
  struct StateData {};
  typedef ${declaration} Read_input;
  typedef ${declaration} Read_output;
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`,
        );

        try {
            const result = await buildContractWithClang({
                contractPath,
                contractName: "Unsafe",
                slot: 28,
                corePath: join(directory, "missing-core"),
                outDir: directory,
                skipVerify: true,
                wasmClang: join(directory, "must-not-run-clang"),
                calleePrelude: "",
            });

            expect(result.ok).toBe(false);
            expect(result.wasmPath).toBeUndefined();
            expect(result.stderr).toContain(`${name} is forbidden`);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
}

const LOG_HEADER_CONTRACT = `
using namespace QPI;
struct Unsafe : public ContractBase {
  struct LogMessage { uint64 counter; uint32 _type; sint8 _terminator; };
  struct StateData { uint32 calls; };
  struct Emit_input {}; struct Emit_output {};
  struct Emit_locals { LogMessage message; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Emit) {
    LOG_INFO(locals.message);
    state.mut().calls += 1;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Emit, 1);
  }
};`;

const LOG_HEADER_MESSAGE = "must open with a 4-byte word reserved for the contract index";

async function buildLogHeaderContract(fileName: string): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), "qinit-log-header-gate-"));
    const contractPath = join(directory, fileName);
    writeFileSync(contractPath, LOG_HEADER_CONTRACT);

    try {
        const result = await buildContractWithClang({
            contractPath,
            contractName: "Unsafe",
            slot: 28,
            corePath: join(directory, "missing-core"),
            outDir: directory,
            skipVerify: true,
            wasmClang: join(directory, "must-not-run-clang"),
            calleePrelude: "",
        });

        return result.stderr ?? "";
    } catch (error: any) {
        // Past the gate the stub Clang path is reached and throws, which is itself the answer here.
        return String(error?.message ?? error);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test("a log payload that spans the reserved contract-index word fails the build", async () => {
    expect(await buildLogHeaderContract("Unsafe.h")).toContain(LOG_HEADER_MESSAGE);
});

// These two ship with the defect, so the gate has to stay off for them without anyone passing strict.
test.each(["VottunBridge.h", "qRWA.h"])("%s is exempt from the log header gate by default", async (fileName) => {
    expect(await buildLogHeaderContract(fileName)).not.toContain(LOG_HEADER_MESSAGE);
});

// `div(a, b)` without its namespace binds to MSVC's C runtime once the contract reaches Core, so the gate
// rejects it here, on both backends, before a compiler is ever spawned. Core's own contracts are exempt.
const BARE_DIV_CONTRACT = `
using namespace QPI;
struct Ratio : public ContractBase {
  struct StateData { uint64 last; };
  struct Read_input { uint64 a; uint64 b; };
  struct Read_output { uint64 q; };
  PUBLIC_FUNCTION(Read) { output.q = div(input.a, input.b); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

test("a bare div is rejected before clang runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-bare-div-gate-"));
    const contractPath = join(directory, "Ratio.h");
    writeFileSync(contractPath, BARE_DIV_CONTRACT);

    try {
        const result = await buildContractWithClang({
            contractPath,
            contractName: "Ratio",
            slot: 28,
            corePath: join(directory, "missing-core"),
            outDir: directory,
            skipVerify: true,
            wasmClang: join(directory, "must-not-run-clang"),
            calleePrelude: "",
        });

        expect(result.ok).toBe(false);
        expect(result.wasmPath).toBeUndefined();
        expect(result.stderr).toContain("Qubic protocol violations:");
        expect(result.stderr).toContain("write `QPI::div(…)`");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a system contract with a bare div passes the gate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-bare-div-system-"));
    const contractPath = join(directory, "Ratio.h");
    writeFileSync(contractPath, BARE_DIV_CONTRACT);

    try {
        // The gate lets it through, so the build reaches the stub compiler and fails there, not on the rule.
        const outcome = await buildContractWithClang({
            contractPath,
            contractName: "Ratio",
            slot: 28,
            corePath: join(directory, "missing-core"),
            outDir: directory,
            skipVerify: true,
            contractKind: "system",
            wasmClang: join(directory, "must-not-run-clang"),
            calleePrelude: "",
        }).then(
            (result) => result.stderr ?? "",
            (error: any) => String(error?.message ?? error),
        );

        expect(outcome).not.toContain("QPI::div");
        expect(outcome).toContain("must-not-run-clang");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test.skipIf(!HAS_CORE)("the TypeScript backend rejects a bare div with the same message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-bare-div-ts-"));

    try {
        const result = await buildContractWithTypeScript({
            source: BARE_DIV_CONTRACT,
            contractName: "Ratio",
            slot: 28,
            corePath: CORE_PATH,
            outDir: directory,
            skipVerify: true,
        });

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("write `QPI::div(…)`");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
