// Pins valid expression forms that must compile under the strict gate.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeRunner } from "../support/edge-compile";

const compileAndRun = edgeRunner("ExpressionEdge");

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

describe("edge audit — valid expression lowering", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("sizeof(postfix expression) uses the operand type without evaluating it", async () => {
        const source = wrap(
            "",
            `
      uint32 value = 5;
      uint64 size = sizeof(value++);
      state.mut().result = size + value * 10;
    `,
        );
        expect(await compileAndRun(source)).toBe(54n);
    });

    test("sizeof(arithmetic expression) uses the promoted result type", async () => {
        const source = wrap(
            "",
            `
      uint16 value = 5;
      state.mut().result = sizeof(value + 1);
    `,
        );
        expect(await compileAndRun(source)).toBe(4n);
    });

    test("member access on an aggregate return temporary", async () => {
        const source = wrap(
            `struct Pair { uint64 value; };
       static Pair make() { Pair p{}; p.value = 9; return p; }`,
            `state.mut().result = make().value;`,
        );
        expect(await compileAndRun(source)).toBe(9n);
    });
});
