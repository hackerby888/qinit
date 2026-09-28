import { HAS_CORE } from "../../../../test-utils/paths";
// Checks that `auto` preserves initializer types through later operations.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeRunner } from "../support/edge-compile";

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const probe = edgeRunner("AutoEdge");

const run = (members: string, body: string) => probe(wrap(members, body));

describe.skipIf(!HAS_CORE)("edge audit — auto type deduction", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("auto deduced from uint32 retains 32-bit arithmetic", async () => {
        expect(await run("", `uint32 source = 4294967295u; auto value = source; state.mut().result = value + 1u;`)).toBe(0n);
    });

    test("auto deduced from a uint32 helper return retains 32-bit arithmetic", async () => {
        expect(await run(`static uint32 source() { return 4294967295u; }`, `auto value = source(); state.mut().result = value + 1u;`)).toBe(0n);
    });

    test("auto deduced from uint16 wraps on postfix increment", async () => {
        expect(await run("", `uint16 source = 65535; auto value = source; value++; state.mut().result = value;`)).toBe(0n);
    });

    test("auto deduced from sint8 preserves signed comparisons", async () => {
        expect(await run("", `sint8 source = -1; auto value = source; state.mut().result = value < 0 ? 1 : 0;`)).toBe(1n);
    });

    test("auto deduced from an explicit uint32 cast retains the cast type", async () => {
        expect(await run("", `auto value = (uint32)4294967295u; state.mut().result = value + 1u;`)).toBe(0n);
    });
});
