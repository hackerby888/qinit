import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseContractDefinitionSource } from "../../src/contract-definitions";
import { parseContractDefinitions, systemContractDescriptions } from "../../src/system-contracts";

test("shared parser keeps numeric indexes and contract state blocks", () => {
    const parsed = parseContractDefinitionSource(`
#define FIRST_CONTRACT_INDEX 1
#define CONTRACT_INDEX FIRST_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE FirstState
#define CONTRACT_STATE2_TYPE FirstState2
#include "contracts/First.h"

constexpr TESTEX_CONTRACT_INDEX = (CONTRACT_INDEX + 1);
#define CONTRACT_INDEX TESTEX_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE TestState
#define CONTRACT_STATE2_TYPE TestState2
#include "contracts/TestExample.h"

#define LITEDYN_CONTRACT_INDEX WASM_RESERVED_SLOT_BASE
#define CONTRACT_INDEX LITEDYN_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE DynamicState
#define CONTRACT_STATE2_TYPE DynamicState2
#include "extensions/wasm/contract.h"
`);

    expect(parsed.indexConstants).toEqual([{ name: "FIRST", index: 1 }]);
    expect(parsed.contractStateBlocks).toEqual([
        {
            indexName: "FIRST",
            stateType: "FirstState",
            include: "contracts/First.h",
        },
        {
            indexName: "TESTEX",
            stateType: "TestState",
            include: "contracts/TestExample.h",
        },
        {
            indexName: "LITEDYN",
            stateType: "DynamicState",
            include: "extensions/wasm/contract.h",
        },
    ]);
});

test("contract descriptions keep their indexes across multiline and symbolic epochs", () => {
    const parsed = parseContractDefinitions(`
static const ContractDescription contractDescriptions[] = {
  {
    "FIRST",
    66,
    10000,
    0
  },
  { "SECOND", CONSTRUCTION_EPOCH, 10000, 0 },
  { "THIRD", 88, 10000, 0 },
};
`);

    expect([...parsed.names]).toEqual([
        [0, "FIRST"],
        [1, "SECOND"],
        [2, "THIRD"],
    ]);
    expect([...parsed.epochs]).toEqual([
        [0, 66],
        [2, 88],
    ]);
});

test("systemContractDescriptions reads contract_def without loading contract sources", () => {
    const core = mkdtempSync(join(tmpdir(), "qinit-contract-descriptions-"));
    try {
        const contractCore = join(core, "src", "contract_core");
        mkdirSync(contractCore, { recursive: true });
        writeFileSync(
            join(contractCore, "contract_def.h"),
            `
#define FIRST_CONTRACT_INDEX 1
#include "contracts/First.h"
#define EXAMPLE_CONTRACT_INDEX 2
#include "contracts/TestExample.h"
#define DYNAMIC_CONTRACT_INDEX 3
#include "contracts/Dynamic.h"
static const ContractDescription contractDescriptions[] = {
  { "", 0, 0, 0 },
  { "FIRST", 66, 10000, 0 },
  { "EXAMPLE", 67, 10000, 0 },
  { "LDYN0", 0, 10000, 0 },
};
`,
        );

        expect(systemContractDescriptions(core)).toEqual([{ index: 1, name: "FIRST", constructionEpoch: 66 }]);
    } finally {
        rmSync(core, { recursive: true, force: true });
    }
});
