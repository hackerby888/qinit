// gtest is a third compile path, parsing through parseToAst rather than the compile driver; it reaches the same preprocessor, so cheatcodes work there too.
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
