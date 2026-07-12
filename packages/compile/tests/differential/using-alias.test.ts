import { CORE_PATH } from "../../../../test-utils/paths";
// C++11 type aliases (`using X = Y;`) in struct and function scope — the only scopes Qubic allows
import { describe, test, expect, beforeAll } from "bun:test";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  using Amount = sint64;
  using Counter32 = uint32;
  using Registry = HashMap<id, Amount, 16>;

  struct StateData { Amount total; Counter32 hits; sint64 readback; Registry byUser; };

  struct Add_input { Amount v; };
  struct Add_output {};
  struct Add_locals { Amount fetched; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Add) {
    using Local = sint64;
    Local doubled = input.v * 2;
    state.mut().total = state.get().total + doubled;
    state.mut().hits = state.get().hits + 1;

    state.mut().byUser.set(qpi.invocator(), state.get().total);
    state.get().byUser.get(qpi.invocator(), locals.fetched);
    state.mut().readback = locals.fetched;
  }

  struct Get_input {};
  struct Get_output { Amount total; uint64 hits; sint64 stored; };
  PUBLIC_FUNCTION(Get) {
    output.total = state.get().total;
    output.hits = state.get().hits;
    output.stored = state.get().readback;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Add, 1); REGISTER_USER_FUNCTION(Get, 1);
  }
};`;

function i64(b: Uint8Array, off = 0): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(off, true);
}

describe("using type aliases", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("struct-scope and function-scope aliases compile and resolve", async () => {
    const r = await compileContract({ source: SRC, name: "Alias", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    const errs = r.diagnostics.filter((d) => d.severity === "error");
    if (errs.length) console.log("  COMPILE ERRORS:", errs.map((e) => e.message).join("\n"));
    expect(errs).toHaveLength(0);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(28, r.wasm);

    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);

    const inBytes = new Uint8Array(8);
    new DataView(inBytes.buffer).setBigInt64(0, 21n, true);
    sim.procedure(28, 1, inBytes, { invocator: user });

    const g = sim.query(28, 1);
    expect(i64(g, 0)).toBe(42n);   // total: 21 * 2 through Local + Amount aliases
    expect(i64(g, 8)).toBe(1n);    // hits through Counter32 alias
    expect(i64(g, 16)).toBe(42n);  // byUser through Registry alias (HashMap of aliased value type)
  });
});
