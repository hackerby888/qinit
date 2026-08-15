// Regression inventory: compiler-generated WASM names must never alias QPI/C++ user names.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeRunner } from "../support/edge-compile";

const compileAndRun = edgeRunner("NameEdge");

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

describe("edge audit — hygienic generated names", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("switch selector temporary does not overwrite user local sw0", async () => {
        const source = wrap(
            "",
            `
      uint64 sw0 = 99;
      uint64 selector = 1;
      switch (selector) { case 1: break; default: break; }
      state.mut().result = sw0;
    `,
        );
        expect(await compileAndRun(source)).toBe(99n);
    });

    test("postfix temporary does not overwrite user local tmp0", async () => {
        const source = wrap(
            "",
            `
      uint64 tmp0 = 77;
      uint64 value = 5;
      uint64 old = value++;
      state.mut().result = tmp0 + old * 0 + value * 0;
    `,
        );
        expect(await compileAndRun(source)).toBe(77n);
    });

    test("ternary result temporary does not overwrite user local tmp0", async () => {
        const source = wrap(
            "",
            `
      uint64 tmp0 = 77;
      uint64 a = 0;
      uint64 b = 0;
      uint64 selected = true ? (a = 1) : (b = 2);
      state.mut().result = tmp0 + selected * 0;
    `,
        );
        expect(await compileAndRun(source)).toBe(77n);
    });

    test("entrypoint local ctx does not collide with hidden WASM context parameter", async () => {
        const source = wrap("", `uint64 ctx = 7; state.mut().result = ctx;`);
        expect(await compileAndRun(source)).toBe(7n);
    });

    test("aggregate-return helper local ret does not collide with hidden return pointer", async () => {
        const source = wrap(
            `struct Pair { uint64 value; };
       static Pair make(uint64 x) { uint64 ret = 7; Pair p{}; p.value = ret + x; return p; }`,
            `Pair p = make(1); state.mut().result = p.value;`,
        );
        expect(await compileAndRun(source)).toBe(8n);
    });

    test("by-value aggregate copy does not collide with user local bv_p", async () => {
        const source = wrap(
            `struct Pair { uint64 value; };
       static uint64 change(Pair p) { uint64 bv_p = 7; p.value = 9; return bv_p + p.value; }`,
            `Pair p{}; p.value = 1; state.mut().result = change(p);`,
        );
        expect(await compileAndRun(source)).toBe(16n);
    });
});
