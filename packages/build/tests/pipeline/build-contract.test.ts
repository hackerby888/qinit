import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "../../src";

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
