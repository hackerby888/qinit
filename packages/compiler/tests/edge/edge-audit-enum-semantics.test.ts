import { HAS_CORE } from "../../../../test-utils/paths";
// Checks enum storage width, signedness, and aggregate placement.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeWords } from "../support/edge-compile";

const wrap = (enumDecl: string, stateExtra: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${enumDecl}
  struct StateData { uint64 result; ${stateExtra} };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const run = edgeWords("EnumEdge");

describe.skipIf(!HAS_CORE)("edge audit — enum underlying types", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("uint64-backed enum comparison is unsigned", async () => {
        const source = wrap(
            `enum class E : uint64 { Low = 1, High = 0x8000000000000000ull };`,
            "",
            `E value = E::High; state.mut().result = value > E::Low ? 1 : 0;`,
        );
        expect(await run(source)).toEqual([1n]);
    });

    test("signed narrow enum field sign-extends when loaded", async () => {
        const source = wrap(
            `enum class E : sint8 { Negative = -1, Zero = 0 };`,
            `E stored;`,
            `state.mut().stored = E::Negative;
       state.mut().result = state.get().stored == E::Negative ? 1 : 0;`,
        );
        expect(await run(source)).toEqual([1n, 0xffn]);
    });

    test("explicit enum width participates in struct layout", async () => {
        const source = wrap(
            `enum class E : uint8 { Zero = 0, One = 1 };`,
            `E stored; uint32 tail;`,
            `state.mut().stored = E::One; state.mut().tail = 9; state.mut().result = 1;`,
        );
        // result@0 (8), stored@8 (1), padding, tail@12 (4) => 16.
        expect(await run(source)).toEqual([1n, 1n | (9n << 32n)]);
    });

    test("implicit enumerator values advance after explicit values", async () => {
        const source = wrap(`enum E { A = 4, B, C = 9, D };`, "", `state.mut().result = B * 100 + D;`);
        expect(await run(source)).toEqual([510n]);
    });
});
