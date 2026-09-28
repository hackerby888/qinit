import { HAS_CORE } from "../../../../test-utils/paths";
// Checks native-compatible implicit conversions at function-call boundaries.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeWords } from "../support/edge-compile";

const wrap = (helper: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; uint64 denominator; uint64 adjacent; };
  ${helper}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const probeWords = edgeWords("ParamConversionEdge");

// denominator and adjacent ride along in every case, so a conversion that spills into them shows.
async function run(helper: string, body: string, rest = [0n, 0n]): Promise<bigint> {
    const [result, ...others] = await probeWords(wrap(helper, body));
    expect(others).toEqual(rest);

    return result;
}

describe.skipIf(!HAS_CORE)("edge audit — implicit parameter conversions", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a uint8 value parameter narrows the argument modulo 256", async () => {
        expect(await run(`static uint64 cv(uint8 value) { return value; }`, `state.mut().result = cv(300);`)).toBe(44n);
    });

    test("a sint8 value parameter narrows and sign-extends the argument", async () => {
        expect(await run(`static sint64 cv(sint8 value) { return value; }`, `state.mut().result = (uint64)cv(255);`)).toBe(0xffff_ffff_ffff_ffffn);
    });

    test("a uint16 value parameter narrows the argument modulo 65536", async () => {
        expect(await run(`static uint64 cv(uint16 value) { return value; }`, `state.mut().result = cv(65537);`)).toBe(1n);
    });

    test("a bool value parameter canonicalizes a nonzero argument", async () => {
        expect(await run(`static uint64 cv(bool value) { return value ? 1 : 0; }`, `state.mut().result = cv(2);`)).toBe(1n);
    });

    test("a default argument is converted to its declared uint8 parameter type", async () => {
        expect(await run(`static uint64 cv(uint8 value = 300) { return value; }`, `state.mut().result = cv();`)).toBe(44n);
    });

    test("a const uint8 reference binds to a converted temporary", async () => {
        expect(await run(`static uint64 cv(const uint8& value) { return value; }`, `state.mut().result = cv(300);`)).toBe(44n);
    });

    test("a scalar state field binds to a converted temporary for a const uint128 reference", async () => {
        expect(
            await run(
                ``,
                `state.mut().denominator = 2; state.mut().adjacent = 1;
       uint128 numerator = (uint128)84;
       state.mut().result = div<uint128>(numerator, state.get().denominator).low;`,
                [2n, 1n],
            ),
        ).toBe(42n);
    });

    test("a widened product divides by a scalar state field through a const uint128 reference", async () => {
        expect(
            await run(
                ``,
                `state.mut().denominator = 1000000; state.mut().adjacent = 450000;
       uint128 numerator = (uint128)150000 * (uint128)state.get().adjacent;
       state.mut().result = div<uint128>(numerator, state.get().denominator).low;`,
                [1000000n, 450000n],
            ),
        ).toBe(67500n);
    });
});
