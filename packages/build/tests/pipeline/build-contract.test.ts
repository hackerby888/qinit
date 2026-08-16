import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "../../src";

test("skipVerify still rejects public LinkedList before Clang", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-linked-list-gate-"));
    const contractPath = join(directory, "Unsafe.h");
    writeFileSync(
        contractPath,
        `
using namespace QPI;
struct Unsafe : public ContractBase {
  struct StateData {};
  typedef LinkedList<uint64, 8> Read_input;
  typedef LinkedList<uint64, 8> Read_output;
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
        expect(result.stderr).toContain("LinkedList is forbidden");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
