// The line a cheat reports is the join key between the wire and the IDL, and both backends compute it
// independently. It is derived from the real prelude rather than pinned, because injecting the shim
// changes the prelude's length — these tests fail if anyone freezes the number.
import { expect, test } from "bun:test";
import { compileContract } from "../../src/driver/compile-contract";
import { loadQpiHeader } from "../../src/driver/header";
import { SCAFFOLD_MACROS } from "../../src/driver/qpi/scaffold";
import { HAS_CORE } from "../../../../test-utils/paths";

const qpiHeader = HAS_CORE ? loadQpiHeader() : "";

function source(padding: string): string {
    return `${padding}using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { uint64 total; };
    struct Put_input { uint64 amount; };
    struct Put_output {};
    PUBLIC_PROCEDURE(Put) {
        CC_PRINT("here", input.amount);
        state.mut().total += input.amount;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Put, 1); }
};`;
}

async function reportedLine(padding: string): Promise<number> {
    const result = await compileContract({ source: source(padding), contractName: "LineBase", slot: 27, qpiHeader });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    return result.idl!.cheats[0].line;
}

test.if(HAS_CORE)("a cheat reports the user's own line, not a line in the prelude", async () => {
    // The CC_PRINT sits on the 8th line of the contract text.
    expect(await reportedLine("")).toBe(8);
});

test.if(HAS_CORE)("the reported line tracks padding, so the base is derived rather than frozen", async () => {
    expect(await reportedLine("\n".repeat(20))).toBe(28);
});

test("the scaffold is what the base is measured from, so its size is not assumed anywhere", () => {
    // A guard for the derivation itself: if this constant is ever inlined into a base, this test is
    // the one that goes stale first.
    expect(SCAFFOLD_MACROS.split("\n").length).toBeGreaterThan(50);
});
