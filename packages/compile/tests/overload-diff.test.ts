import { CORE_PATH } from "../../../test-utils/paths";
// Overload-resolution parity for static helpers.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 f0; uint64 f1; uint64 f2; uint64 f3; uint64 f4; uint64 f5; uint64 f6; uint64 f7; };
  struct Go_input { uint64 a; uint64 b; uint64 c; uint64 d; };
  struct Go_output {};

  static uint64 pick(uint32 v)
  {
    return (uint64)(v) + 1000;
  }
  static uint64 pick(uint64 v)
  {
    return v + 2000;
  }
  static sint64 sgn(sint32 v)
  {
    return v < 0 ? -1 : 1;
  }
  static sint64 sgn(uint32 v)
  {
    return 7;
  }

  PUBLIC_PROCEDURE(Go)
  {
    state.mut().f0 = pick((uint64)(input.a));
    state.mut().f1 = pick((uint32)(input.b));
    state.mut().f2 = (uint64)(sgn((sint32)(input.c)));
    state.mut().f3 = (uint64)(sgn((uint32)(input.d)));
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// native-verified: f0 = pick(uint64)(5)+2000, f1 = pick(uint32)(6)+1000, f2 = sgn(sint32)(-2) = -1, f3 = sgn(uint32) = 7
const EXPECTED = "d507000000000000ee03000000000000ffffffffffffffff07000000000000000000000000000000000000000000000000000000000000000000000000000000";
const INPUT = [5n, 6n, 0xfffffffen, 3n];

const TERNARY_SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 f0; uint64 f1; uint64 f2; uint64 f3; uint64 f4; uint64 f5; uint64 f6; uint64 f7; };
  struct Go_input { uint64 a; uint64 b; uint64 c; uint64 d; };
  struct Go_output {};
  static sint16 neg(sint32 v)
  {
    return (sint16)(v);
  }
  PUBLIC_PROCEDURE(Go)
  {
    state.mut().f0 = (uint64)((sint64)(((input.a) ? (neg((sint32)(4294967295u))) : ((uint32)(3)))));
    state.mut().f1 = (uint64)((sint64)(((input.a) ? ((sint16)(65535)) : ((uint32)(3)))));
    state.mut().f2 = (uint64)((sint64)(sadd((sint64)(((input.a) ? (neg((sint32)(4294967295u))) : ((uint32)(3)))), (sint64)(1000ll))));
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// native-verified: each ternary takes the sint16 -1 arm, converted to uint32 0xFFFFFFFF; f2 = sadd(0xFFFFFFFF, 1000)
const TERNARY_EXPECTED = "ffffffff00000000ffffffff00000000e70300000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

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

const checkBothSides = async (source: string, name: string, expected: string): Promise<void> => {
  const ours = await compileContract({ source, name, slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
  expect(ours.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  expect(runState(ours.wasm)).toBe(expected);

  if (wasiOk) {
    const dir = mkdtempSync(join(tmpdir(), `${name}-`));
    try {
      writeFileSync(join(dir, `${name}.h`), source);
      const built = await buildContract({ contractPath: join(dir, `${name}.h`), name, slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
      expect(built.ok).toBe(true);
      expect(runState(new Uint8Array(readFileSync(built.so!)))).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
};

describe("helper overload resolution", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("call sites pick the overload matching the cast argument", async () => {
    await checkBothSides(SOURCE, "OV", EXPECTED);
  }, 180000);

  test("ternary arms convert to their common type", async () => {
    await checkBothSides(TERNARY_SOURCE, "TERN", TERNARY_EXPECTED);
  }, 180000);
});
