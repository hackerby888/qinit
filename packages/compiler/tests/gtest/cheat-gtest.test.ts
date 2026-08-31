// gtest is a third compile path: it parses the contract through parseToAst rather than the full
// compile driver. That reaches the same preprocessor, so cheatcodes work there too — this is the test
// that says so, because nothing else exercises a cheat-carrying contract under gtest.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileGtestWithTypeScript } from "../../src/index";
import { HAS_CORE } from "../../../../test-utils/paths";

const source = readFileSync(join(import.meta.dir, "../../../../fixtures/Cheats.h"), "utf8");

const testSource = `#include "contract_testing.h"

class ContractTestingCheats : protected ContractTesting
{
public:
    ContractTestingCheats() { INIT_CONTRACT(Cheats); callSystemProcedure(Cheats_CONTRACT_INDEX, INITIALIZE); }
};

TEST(Cheats, Compiles)
{
    ContractTestingCheats t;
    EXPECT_EQ(1, 1);
}
`;

test.if(HAS_CORE)("a cheat-carrying contract compiles under gtest", async () => {
    const result = await compileGtestWithTypeScript({ source, testSource, contractName: "Cheats", slot: 28 });

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
});
