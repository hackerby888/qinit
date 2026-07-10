// 32-bit width fidelity: native clang computes int-rank expressions in 32-bit registers, so
// results wrap at 32 bits (sign- or zero-extended into wider contexts), 32-bit shifts mask their
// count mod 32, and the qpi sadd/smul overloads clamp at the extremes of their own width
// (math_lib.h int/uint versions). Our i64 value model must reduce back to the canonical 32-bit
// form at each 32-bit operation. Every case here is a differential against the wasi-native build;
// the expected values are the native results, asserted so the oracle itself stays honest.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const wrap = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// body → expected state.a (the native result; the differential below re-derives it from the
// wasi build when the toolchain is present, and fails if the two ever disagree).
const CASES: Record<string, { body: string; expect: bigint }> = {
  "sint32 add overflow wraps": {
    body: `sint32 x = 2000000000; sint64 y = x + x; state.mut().a = (uint64)y;`,
    expect: 18446744073414584320n,
  },
  "sint32 overflow comparison sees the wrapped sign": {
    body: `sint32 x = 2000000000; state.mut().a = (x + x > 0) ? 1 : 2;`,
    expect: 2n,
  },
  "uint32 mul wraps mod 2^32": {
    body: `uint32 u = 3000000000u; uint64 y = u * 3u; state.mut().a = y;`,
    expect: 410065408n,
  },
  "1 << 31 is INT_MIN": {
    body: `sint32 s = 31; sint64 y = (1 << s); state.mut().a = (uint64)y;`,
    expect: 18446744071562067968n,
  },
  "32-bit shift count masks mod 32": {
    body: `sint32 s = 33; sint32 one = 1; sint64 y = (one << s); state.mut().a = (uint64)y;`,
    expect: 2n,
  },
  "sint16 promoted arithmetic wraps at 32": {
    body: `sint16 h = 30000; sint64 y = h * h * 3; state.mut().a = (uint64)y;`,
    expect: 18446744072114584320n,
  },
  "INT32_MAX++ wraps to INT32_MIN": {
    body: `sint32 x = 2147483647; x++; sint64 y = x; state.mut().a = (uint64)y;`,
    expect: 18446744071562067968n,
  },
  "unary minus INT32_MIN stays INT32_MIN": {
    body: `sint32 x = -2147483647 - 1; sint64 y = -x; state.mut().a = (uint64)y;`,
    expect: 18446744071562067968n,
  },
  "uint32 subtraction wraps": {
    body: `uint32 p = 5; uint32 q = 7; uint64 y = p - q; state.mut().a = y;`,
    expect: 4294967294n,
  },
  "sadd sint32 clamps at INT32_MAX": {
    body: `sint32 p = 2000000000; sint32 q = 2000000000; state.mut().a = (uint64)(sint64)sadd(p, q);`,
    expect: 2147483647n,
  },
  "sadd uint32 clamps at UINT32_MAX": {
    body: `uint32 p = 4000000000u; uint32 q = 4000000000u; state.mut().a = (uint64)sadd(p, q);`,
    expect: 4294967295n,
  },
  "smul sint32 clamps at INT32_MAX": {
    body: `sint32 p = 100000; sint32 q = 100000; state.mut().a = (uint64)(sint64)smul(p, q);`,
    expect: 2147483647n,
  },
  "sadd sint64 still clamps at INT64_MAX": {
    body: `sint64 p = 9223372036854775807LL; sint64 q = 5; state.mut().a = (uint64)sadd(p, q);`,
    expect: 9223372036854775807n,
  },
  "smul uint64 still clamps at UINT64_MAX": {
    body: `uint64 p = 18446744073709551615ULL; uint64 q = 3; state.mut().a = smul(p, q);`,
    expect: 18446744073709551615n,
  },
};

const run = (wasm: Uint8Array): bigint => {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);
  sim.procedure(27, 1, undefined, { invocator: user });
  const st = sim.contracts.get(27)!.state();
  return new DataView(st.buffer, st.byteOffset).getBigUint64(0, true);
};

const wasiOk = (() => {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
})();

describe("32-bit width fidelity vs native", () => {
  beforeAll(async () => {
    await initK12();
  });

  for (const [name, c] of Object.entries(CASES)) {
    test(name, async () => {
      const src = wrap(c.body);
      const ours = await compileContract({ source: src, name: "W32", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
      expect(ours.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
      expect(run(ours.wasm)).toBe(c.expect);

      if (wasiOk) {
        const dir = mkdtempSync(join(tmpdir(), "w32-"));
        writeFileSync(join(dir, "W32.h"), src);
        const built = await buildContract({ contractPath: join(dir, "W32.h"), name: "W32", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
        expect(built.ok).toBe(true);
        expect(run(new Uint8Array(readFileSync(built.so!)))).toBe(c.expect);
      }
    }, 180000);
  }
});
