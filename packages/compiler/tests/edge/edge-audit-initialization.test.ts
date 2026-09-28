import { DiagnosticSeverity } from "../../src/shared/enums";
import { HAS_CORE } from "../../../../test-utils/paths";
// Covers direct, braced, and parenthesized initialization in helper bodies.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeCompiler, edgeRunner } from "../support/edge-compile";

const compile = edgeCompiler("InitEdge");

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const run = edgeRunner("InitEdge");

describe.skipIf(!HAS_CORE)("edge audit — direct and aggregate initialization", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("scalar direct-list initialization preserves its value", async () => {
        expect(await run(wrap("", `uint64 value{7}; state.mut().result = value;`))).toBe(7n);
    });

    test("scalar direct-parenthesized initialization preserves its value", async () => {
        expect(await run(wrap("", `uint64 value(7); state.mut().result = value;`))).toBe(7n);
    });

    test("aggregate direct-list initialization stores every field", async () => {
        const source = wrap(`struct Pair { uint64 left; uint64 right; };`, `Pair pair{7, 9}; state.mut().result = pair.left + pair.right;`);
        expect(await run(source)).toBe(16n);
    });

    test("aggregate copy-list initialization remains supported", async () => {
        const source = wrap(`struct Pair { uint64 left; uint64 right; };`, `Pair pair = {7, 9}; state.mut().result = pair.left + pair.right;`);
        expect(await run(source)).toBe(16n);
    });

    test("too many aggregate initializers are rejected", async () => {
        const source = wrap(`struct Pair { uint64 left; uint64 right; };`, `Pair pair = {7, 9, 11}; state.mut().result = pair.left + pair.right;`);
        const result = await compile(source);
        const errors = result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
        expect(errors.some((d) => /initializer|too many|field/i.test(d.message))).toBe(true);
        expect(result.wasm).toHaveLength(0);
    });
});
