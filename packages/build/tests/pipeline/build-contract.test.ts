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
