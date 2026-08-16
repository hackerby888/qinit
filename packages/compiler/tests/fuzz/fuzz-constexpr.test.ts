import { DiagnosticSeverity } from "../../src/shared/enums";
// Constexpr folding versus runtime evaluation over pinned seeds from `tools/fuzz-gen-constexpr.ts`. The two
// evaluators are independent implementations, so neither needs a hand-written reference to check against.
import { describe, test, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { generate } from "../../tools/fuzz-gen-constexpr";
import { edgeCompiler } from "../support/edge-compile";
import { QubicSimulator } from "@qinit/engine";

const compile = edgeCompiler("ConstexprFuzz");

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18, 22, 25, 30, 35, 40, 45, 50];

const foldedAndRuntime = (wasm: Uint8Array): { folded: bigint; runtime: bigint } => {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, wasm);
    simulator.procedure(27, 1, undefined, { invocator: user });

    const state = simulator.contracts.get(27)!.state();
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    return { folded: view.getBigUint64(0, true), runtime: view.getBigUint64(8, true) };
};

describe("fuzz — constexpr fold versus runtime parity", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const seed of SEEDS) {
        test(`seed ${seed}`, async () => {
            const contract = generate(seed);
            const result = await compile(contract.source);
            expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const { folded, runtime } = foldedAndRuntime(result.wasm);
            expect(`${contract.expression} => ${folded}`).toBe(`${contract.expression} => ${runtime}`);
        }, 120000);
    }
});
