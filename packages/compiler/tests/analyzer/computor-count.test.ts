// the node runs an 8-computor testnet committee; a contract compiled by Qinit sees the same constants, unless it is core's own gtest.
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
// a state sized by the committee: Array wants a power of two, which only the node's 8 is.
const SIZED_STATE = SOURCE.replace("struct StateData { uint64 quorum; };", "struct StateData { Array<uint8, NUMBER_OF_COMPUTORS> seats; };");

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

test.skipIf(!HAS_CORE)("NUMBER_OF_COMPUTORS and QUORUM follow the node's testnet profile", async () => {
    expect(await committee("node")).toEqual([8n, 6n]);

    const sized = await compileContractWithTypeScript({ source: SIZED_STATE, contractName: "Committee", slot: 28, qpiHeader: loadQpiHeader(CORE_PATH) });
    expect(sized.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([]);
    expect(sized.idl?.state.size).toBe(8);
});

// core's own contract gtests are written for its default constants, so their corpus builds drop the profile again.
test.skipIf(!HAS_CORE)("the core-gtest profile keeps core's default committee", async () => {
    expect(await committee("core-gtest")).toEqual([676n, 451n]);
});
