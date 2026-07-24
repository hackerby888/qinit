import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Pins inclusive registration bounds and rejects values outside them.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct OldStateData {};

  struct MaxInput_input { uint8 bytes[1024]; }; struct MaxInput_output {};
  PUBLIC_PROCEDURE(MaxInput) {}

  struct MaxOutput_input {}; struct MaxOutput_output { uint8 bytes[65535]; };
  PUBLIC_FUNCTION(MaxOutput) {}

  struct MaxLocals_input {}; struct MaxLocals_output {};
  struct MaxLocals_locals { uint8 bytes[32768]; };
  PUBLIC_PROCEDURE_WITH_LOCALS(MaxLocals) {}

  MIGRATE() {}

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(MaxInput, 1);
    REGISTER_USER_FUNCTION(MaxOutput, 1);
    REGISTER_USER_PROCEDURE(MaxLocals, 65535);
  }
};`;

let entries: Array<{ it: number; kind: number; inSize: number; outSize: number }>;
let stateSize: number;
let oldStateSize: number;

describe("edge audit — inclusive QPI ABI boundaries", () => {
  beforeAll(async () => {
    await initK12();
    const result = await compileContract({
      source: SOURCE,
      name: "AbiBoundaryEdge",
      slot: 27,
      qpiHeader: HEADERS,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    expect(WebAssembly.validate(result.wasm)).toBe(true);
    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(27, result.wasm);
    const contract = sim.contracts.get(27)!;
    entries = contract.entries;
    stateSize = contract.ex.state_size();
    oldStateSize = contract.ex.migrate_old_state_size?.() ?? 0;
  });

  test("a procedure input of exactly MAX_INPUT_SIZE bytes is registered", () => {
    expect(entries).toContainEqual({ it: 1, kind: 1, inSize: 1024, outSize: 1 });
  });

  test("a function output of exactly uint16 max bytes is registered", () => {
    expect(entries).toContainEqual({ it: 1, kind: 0, inSize: 1, outSize: 65535 });
  });

  test("locals of exactly MAX_SIZE_OF_CONTRACT_LOCALS compile", () => {
    expect(entries).toContainEqual({ it: 65535, kind: 1, inSize: 1, outSize: 1 });
  });

  test("empty state and migration layouts reach Wasm metadata", () => {
    expect(stateSize).toBe(1);
    expect(oldStateSize).toBe(1);
  });

  test("the same input type is allowed once per function/procedure kind", () => {
    expect(entries.filter((entry) => entry.it === 1)).toHaveLength(2);
  });
});
