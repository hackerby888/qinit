// A contract function must not reach a state-mutating host import. The list guarding that is maintained by
// hand, so this pins it: adding an lhost import forces a deliberate decision about its guard here.
import { expect, test } from "bun:test";
import { LHOST_ABI, type LhostImportName } from "@qinit/core";
import { MUTATING_LHOST_IMPORTS } from "../../src/contract/runtime";

const EXPECTED: LhostImportName[] = [
    "acquireShares",
    "bidInIPO",
    "burn",
    "distributeDividends",
    "invokeOc",
    "issueAsset",
    "liteInvokeProcedure",
    "liteSetShareholderProposal",
    "liteSetShareholderVotes",
    "logBytes",
    "markDirty",
    "pauseLog",
    "queryOracle",
    "releaseShares",
    "resumeLog",
    "subscribeOracle",
    "transfer",
    "transferShareOwnershipAndPossession",
    "transferTyped",
    "unsubscribeOracle",
];

test("the mutating lhost imports are exactly the recorded set", () => {
    expect([...MUTATING_LHOST_IMPORTS].sort()).toEqual(EXPECTED);
});

test("every mutating import exists in the generated host ABI", () => {
    const unknown = MUTATING_LHOST_IMPORTS.filter((name) => !(name in LHOST_ABI));

    expect(unknown).toEqual([]);
});

// A new import lands unguarded by default, so the count is pinned too — it moves only with EXPECTED.
test("the host ABI has not grown past the reviewed import set", () => {
    expect(Object.keys(LHOST_ABI)).toHaveLength(64);
});

// Both reviewed and deliberately left off EXPECTED: initialTick is a read, and `cheat` is excluded
// because the list is a per-import ban and CC_PRINT has to work inside a function — its mutating
// opcodes check the entry kind themselves instead.
test("cheat is unguarded on purpose, and its mutating opcodes are refused in a function", () => {
    expect(MUTATING_LHOST_IMPORTS).not.toContain("cheat");
    expect("cheat" in LHOST_ABI).toBe(true);
    expect("initialTick" in LHOST_ABI).toBe(true);
});
