// compileContract's ContractIdl must describe the same ABI that is embedded in the generated WASM.
import { beforeAll, describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader, type ContractIdl } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 balance; uint32 flags; };

  struct Put_input { uint32 tag; uint64 amount; };
  struct Put_output { uint8 ok; uint32 code; };
  struct Get_input { uint16 selector; };
  struct Get_output { uint64 amount; };

  PUBLIC_PROCEDURE(Put) { state.mut().balance = input.amount; output.ok = 1; }
  PUBLIC_FUNCTION(Get) { output.amount = state.get().balance; }
  INITIALIZE() { state.mut().flags = 1; }
  END_EPOCH() { state.mut().flags += 1; }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Put, 7);
    REGISTER_USER_FUNCTION(Get, 9);
  }
};`;

let idl: ContractIdl;

describe("edge audit — compile result IDL fidelity", () => {
  beforeAll(async () => {
    const result = await compileContract({
      source: SOURCE,
      name: "IdlEdge",
      slot: 27,
      qpiHeader: HEADERS,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(WebAssembly.validate(result.wasm)).toBe(true);
    idl = result.idl;
  });

  test("reports naturally aligned persistent state size", () => {
    expect(idl.stateSize).toBe(16);
  });

  test("reports procedure input/output layouts", () => {
    expect(idl.procedures).toEqual([
      { name: "Put", inputType: 7, inSize: 16, outSize: 8 },
    ]);
  });

  test("reports function input/output layouts", () => {
    expect(idl.functions).toEqual([
      { name: "Get", inputType: 9, inSize: 2, outSize: 8 },
    ]);
  });

  test("reports lifecycle procedure mask", () => {
    // INITIALIZE = bit 0, END_EPOCH = bit 2.
    expect(idl.sysprocMask).toBe((1 << 0) | (1 << 2));
  });
});
