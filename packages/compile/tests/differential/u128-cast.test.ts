import { CORE_PATH } from "../../../../test-utils/paths";
// u128 cast semantics regression: `(uint128)(scalarExpr)` must evaluate in scalar domain, then zero-extend into low limb.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 f0; uint64 f1; uint64 f2; uint64 f3; uint64 f4; uint64 f5; uint64 f6; uint64 f7; };
  struct Go_input { uint64 a; uint64 b; uint64 c; uint64 d; };
  struct Go_output {};
  PUBLIC_PROCEDURE(Go)
  {
    uint128 q0 = uint128(0ull, 1ull);
    q0 = (uint128)((input.a - input.b));
    state.mut().f0 = (uint64)(q0.low);
    state.mut().f1 = (uint64)(q0.high);

    uint128 q1 = uint128(0ull, 2ull);
    q1 = (uint128)((input.a * input.b));
    state.mut().f2 = (uint64)(q1.low);
    state.mut().f3 = (uint64)(q1.high);

    uint128 q2 = (uint128)((input.a - input.b));
    state.mut().f4 = (uint64)(q2.low);
    state.mut().f5 = (uint64)(q2.high);

    uint128 q3 = div<uint128>(uint128(1ull, 0ull), ((input.b) ? ((uint128)(input.b)) : (uint128(0ull, 3ull))));
    state.mut().f6 = (uint64)(q3.low);
    state.mut().f7 = (uint64)(q3.high);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// native-verified with a=2, b=5: f0/f1 = 2-5 wrapped in uint64 (high stays 0 — no 128-bit borrow), f2/f3
const EXPECTED = "fdffffffffffffff00000000000000000a000000000000000000000000000000fdffffffffffffff000000000000000033333333333333330000000000000000";
const INPUT = [2n, 5n, 0n, 0n];

const runState = (wasm: Uint8Array): string => {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  INPUT.forEach((v, i) => dv.setBigUint64(i * 8, v, true));
  sim.procedure(27, 1, buf, { invocator: user });
  const st = sim.contracts.get(27)!.state();
  return Buffer.from(st.slice(0, 64)).toString("hex");
};

const wasiOk = (() => {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
})();

describe("uint128 casts of scalar expressions", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("scalar-domain evaluation and computed decl-inits", async () => {
    const ours = await compileContract({ source: SOURCE, name: "UC", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
    expect(ours.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(runState(ours.wasm)).toBe(EXPECTED);

    if (wasiOk) {
      const dir = mkdtempSync(join(tmpdir(), "u128cast-"));
      try {
        writeFileSync(join(dir, "UC.h"), SOURCE);
        const built = await buildContract({ contractPath: join(dir, "UC.h"), name: "UC", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
        expect(built.ok).toBe(true);
        expect(runState(new Uint8Array(readFileSync(built.so!)))).toBe(EXPECTED);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 180000);
});
