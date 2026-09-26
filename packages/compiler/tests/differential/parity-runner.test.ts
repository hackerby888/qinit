// the parity runner has to see all of a probe's state: two builds agreeing on the answer word can still differ after it.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { PARITY_ARENA_BYTES, PARITY_SLOT, runState } from "../support/parity-runner";

const probe = (extra: number) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; uint64 extra; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { state.mut().result = 7; state.mut().extra = ${extra}; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(extra: number) {
    const compiled = await compileContractWithTypeScript({
        source: probe(extra),
        contractName: "WideProbe",
        slot: PARITY_SLOT,
        qpiHeader: loadQpiHeader(CORE_PATH),
        arenaSizeBytes: PARITY_ARENA_BYTES,
    });
    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    return runState(compiled.wasm);
}

describe.skipIf(!HAS_CORE)("parity runner", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a difference past the answer word is a difference", async () => {
        const first = await run(1);
        const second = await run(2);

        expect(first.resultWord).toBe(7n);
        expect(second.resultWord).toBe(7n);
        expect(first.stateHex).toHaveLength(32);
        expect(first.stateHex).not.toBe(second.stateHex);
    });
});
