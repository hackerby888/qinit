import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src";

const CORE = CORE_PATH;
const HEADER = loadQpiHeader(CORE);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Pair { uint64 left; uint64 right; };
  struct StateData {
    Array<uint64, 8> values;
    AssetOwnershipSelect ownership;
    AssetPossessionSelect possession;
    uint64 checksum;
    Array<Pair, 2> pairs;
  };
  struct Run_input { id who; uint32 small; uint32 neighbor; };
  struct Run_output {};
  PUBLIC_PROCEDURE(Run) {
    state.mut().values.setAll(3);
    state.mut().values.set(1, 9);
    state.mut().values.setRange(2, 4, 7);
    state.mut().checksum = state.get().values.capacity();
    state.mut().checksum += state.get().values.get(1);
    state.mut().checksum += state.get().values.get(2);
    state.mut().checksum += state.get().values.rangeEquals(2, 4, 7);
    state.mut().pairs.set(0, {11, 13});
    state.mut().checksum += state.get().pairs.get(0).left;
    state.mut().checksum += state.get().pairs.get(0).right;
    state.mut().values.set(5, input.small);
    state.mut().checksum += state.get().values.get(5);
    state.mut().ownership = AssetOwnershipSelect::byManagingContract(42);
    state.mut().possession = AssetPossessionSelect::byPossessor(input.who);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`;

describe("source-method lowering ratchet", () => {
  beforeAll(initK12);

  test("Array and selector behavior comes from authoritative method bodies", async () => {
    const result = await compileContract({
      source: SOURCE,
      name: "SourceMethods",
      slot: 27,
      qpiHeader: HEADER,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    const who = new Uint8Array(32).fill(0x5a);
    const input = new Uint8Array(40);
    input.set(who);
    const inputView = new DataView(input.buffer);
    inputView.setUint32(32, 2, true);
    inputView.setUint32(36, 1, true);
    const contract = sim.deploy(27, result.wasm);
    sim.procedure(27, 1, input, { invocator: who, originator: who });
    const state = contract.state();
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    expect(view.getBigUint64(144, true)).toBe(51n);
    expect(view.getUint16(96, true)).toBe(42);
    expect(view.getUint8(98)).toBe(1);
    expect(state.slice(104, 136)).toEqual(who);
    expect(view.getUint8(139)).toBe(1);
  });

  test("name-specific semantic fallbacks cannot return", () => {
    const containers = readFileSync(new URL("../../src/codegen/calls/containers.ts", import.meta.url), "utf8");
    const addr = readFileSync(new URL("../../src/codegen/addr.ts", import.meta.url), "utf8");
    const dispatch = readFileSync(new URL("../../src/codegen/calls/dispatch.ts", import.meta.url), "utf8");
    const qpi = readFileSync(new URL("../../src/codegen/calls/qpi.ts", import.meta.url), "utf8");
    const framework = readFileSync(new URL("../../src/framework.ts", import.meta.url), "utf8");
    const qpiContext = readFileSync(new URL("../../src/compiler/qpi-context.ts", import.meta.url), "utf8");
    const pipeline = readFileSync(new URL("../../src/compiler/pipeline.ts", import.meta.url), "utf8");
    expect(containers).not.toContain('node.type.name === "Array"');
    expect(addr).not.toMatch(/\^\(AssetOwnershipSelect\|AssetPossessionSelect\)::/);
    expect(dispatch).not.toContain('if (m === "nextProposalIndex" || m === "nextFinishedProposalIndex")');
    expect(qpi).not.toContain('invocationReward: Object.freeze({ fwd: "$qpi_invocationReward"');
    expect(qpi).not.toContain('"invocator", "originator"');
    expect(addr).not.toContain('invocator: "$qpi_invocator"');
    expect(addr).not.toContain('originator: "$qpi_originator"');
    expect(framework).not.toMatch(/const CTX\s*=/);
    expect(framework).not.toContain("CTX_SZ");
    expect(qpiContext).not.toContain("QPI_CONTEXT_FALLBACK");
    expect(qpiContext).not.toMatch(/struct\s+QpiContext\s*\{/);
    expect(pipeline).not.toContain("QPI_STUB");
  });
});
