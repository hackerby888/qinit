// A fixture compiles under the manifest's contractName, which clang turns into `#define CONTRACT_STATE_TYPE` — a differently-named struct will not compile.
// The TypeScript compiler finds the struct by discovery, so local tests passed while CI failed nine runs on `struct CounterV2` deployed as `Counter`.
import { test, expect } from "bun:test";
import { wasmFixtureManifest } from "../../../../test-utils/wasm-fixtures";

const CONTRACT_STRUCT = /struct\s+(\w+)\s*:\s*public\s+ContractBase/;

test("every fixture's struct is named after the contract it is compiled as", () => {
    const mismatched: string[] = [];

    for (const [fixtureName, definition] of Object.entries(wasmFixtureManifest)) {
        const declared = CONTRACT_STRUCT.exec(definition.source)?.[1];
        expect(declared, `${definition.sourceFile} declares no ContractBase struct`).toBeDefined();
        if (declared !== definition.contractName) {
            mismatched.push(`${fixtureName} (${definition.sourceFile}): declares '${declared}', compiled as '${definition.contractName}'`);
        }
    }

    expect(mismatched).toEqual([]);
});
