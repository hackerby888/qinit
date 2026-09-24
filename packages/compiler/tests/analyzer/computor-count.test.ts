// every core build seats 676 computors; a contract compiled by Qinit sees the same constants under either profile.
import { expect, test } from "bun:test";
import { initK12, type BuildProfile } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 quorum; };
  struct Size_input {};
  struct Size_output { uint64 seats; uint64 quorum; };
  PUBLIC_FUNCTION(Size) { output.seats = NUMBER_OF_COMPUTORS; output.quorum = QUORUM; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Size, 1); }
};
`;
async function committee(profile: BuildProfile): Promise<bigint[]> {
    await initK12();
    const result = await compileContractWithTypeScript({
        source: SOURCE,
        contractName: "Committee",
        slot: 28,
        qpiHeader: loadQpiHeader(CORE_PATH, profile),
        arenaSizeBytes: 1 << 20,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);

    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(28, result.wasm);
    const output = sim.query(28, 1);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    return [view.getBigUint64(0, true), view.getBigUint64(8, true)];
}

test.skipIf(!HAS_CORE)("NUMBER_OF_COMPUTORS and QUORUM are the mainnet committee under both profiles", async () => {
    expect(await committee("node")).toEqual([676n, 451n]);
    expect(await committee("core-gtest")).toEqual([676n, 451n]);
});
