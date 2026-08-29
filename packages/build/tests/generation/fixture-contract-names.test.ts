// A fixture is compiled under the contractName the manifest gives it, and clang's wrapper turns that
// name into `#define CONTRACT_STATE_TYPE <name>` before including the header. So a header whose struct
// is called something else does not compile there — `use of undeclared identifier`.
//
// The TypeScript compiler finds the contract struct by discovery rather than by name, so every local
// test kept passing while CI's deploy-smoke failed for nine runs on `struct CounterV2` deployed as
// `Counter`. This compares the two names directly, which needs neither clang nor a core checkout.
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
