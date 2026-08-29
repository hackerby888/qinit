import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { compileContractWithTypeScript } from "../../src/index";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";

// qpi.h states its container rules as static_asserts, and C++ evaluates those when the template is
// instantiated. Qinit only checked the containers it rebuilt for the IDL, so a `_locals` container
// skipped every rule: `Array<uint64, 3>` compiled here and failed core's build with a static_assert.
const source = (state: string, locals: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct AssertProbe : public ContractBase {
  struct StateData { uint64 result; ${state} };
  struct X_input {}; struct X_output {};
  struct P_input {}; struct P_output {};
  struct P_locals { ${locals} };
  PUBLIC_PROCEDURE_WITH_LOCALS(P) { state.mut().result = 1; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(P, 1); }
};`;

async function errorsFor(state: string, locals: string): Promise<string[]> {
    const result = await compileContractWithTypeScript({
        source: source(state, locals),
        contractName: "AssertProbe",
        slot: 27,
        qpiHeader: QPI_SNAPSHOT,
        arenaSizeBytes: 1 << 20,
    });
    return result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR).map((d) => d.message);
}

// Capacity, declaration, and the fragment of core's own assert message the diagnostic must carry.
const CONTAINERS: [label: string, declaration: string, message: string][] = [
    ["Array", "Array<uint64, 3> items;", "capacity of the array must be 2^N"],
    ["HashMap", "HashMap<id, uint64, 3> map;", "capacity of the hash map must be 2^N"],
    ["HashSet", "HashSet<id, 3> set;", "must be 2^N"],
    ["Collection", "Collection<uint64, 3> coll;", "must be 2^N"],
    ["LinkedList", "LinkedList<uint64, 3> list;", "must be 2^N"],
    ["BitArray", "BitArray<3> bits;", "must be 2^N"],
];

const VALID = [
    "Array<uint64, 4> items;",
    "HashMap<id, uint64, 8> map;",
    "HashSet<id, 2> set;",
    "Collection<uint64, 16> coll;",
    "LinkedList<uint64, 8> list;",
    "BitArray<64> bits;",
];

describe("a template's static_asserts run when it is instantiated — no core checkout required", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [label, declaration, message] of CONTAINERS) {
        test(`${label} with a non-power-of-two capacity is rejected in _locals`, async () => {
            const errors = await errorsFor("", declaration);
            expect(
                errors.some((error) => error.includes(message)),
                errors.join(" | "),
            ).toBe(true);
        });
    }

    test("a zero capacity is rejected too", async () => {
        const errors = await errorsFor("", "Array<uint64, 0> items;");
        expect(errors.length).toBeGreaterThan(0);
    });

    test("valid power-of-two capacities still compile", async () => {
        expect(await errorsFor("", VALID.join(" "))).toEqual([]);
    });

    // The state path already rejected these through the IDL builder, and must not now report twice.
    test("a state container reports the rule once, not once per sizing query", async () => {
        const errors = await errorsFor("Array<uint64, 3> items;", "");
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.filter((error) => error.includes("2^N")).length).toBeLessThanOrEqual(1);
    });
});
