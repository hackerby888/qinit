import { CORE_PATH } from "../../../../test-utils/paths";
// Semantic validation coverage for invalid constructs.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const wrap = (body: string, members = "") => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const compile = async (source: string) => {
  const r = await compileContract({ source, name: "T", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
  return { wasm: r.wasm, errors: r.diagnostics.filter((d) => d.severity === "error") };
};

interface Rejects {
  src: string;
  msg: RegExp;
}

const REJECTS: Record<string, Rejects> = {
  "nested function definition": {
    src: wrap(`uint64 h(uint64 x) { return x + 1; } state.mut().a = 1;`),
    msg: /nested/i,
  },
  "duplicate local, same type": {
    src: wrap(`uint64 v = 1; uint64 v = 2; state.mut().a = v;`),
    msg: /already declared/i,
  },
  "duplicate local, different type": {
    src: wrap(`uint64 v = 1; sint32 v = 2; state.mut().a = v;`),
    msg: /already declared/i,
  },
  "local shadows outer scope": {
    // Verified divergence: natively the outer v (1) survives the block; our single-slot lowering read back 2. Rejected until
    src: wrap(`uint64 v = 1; { uint64 v = 2; state.mut().a = v; } state.mut().a = v;`),
    msg: /shadow/i,
  },
  "use before declaration": {
    src: wrap(`v = 1; uint64 v = 2; state.mut().a = v;`),
    msg: /before its declaration/i,
  },
  "use after scope exit": {
    src: wrap(`{ uint64 v = 1; } state.mut().a = v;`),
    msg: /scope|declaration/i,
  },
  "duplicate struct member": {
    src: wrap(`state.mut().a = 1;`, `struct S { uint64 x; uint64 x; };`),
    msg: /duplicate member/i,
  },
  "duplicate procedure body": {
    // Verified divergence: dispatch silently picked the first body.
    src: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { state.mut().a = 11; }
  PUBLIC_PROCEDURE(Go) { state.mut().a = 22; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`,
    msg: /already defined|duplicate/i,
  },
  "void variable": {
    src: wrap(`void v; state.mut().a = 1;`),
    msg: /void/i,
  },
  "return value from void procedure": {
    src: wrap(`return 5;`),
    msg: /void/i,
  },
  "missing return in non-void function": {
    src: wrap(`state.mut().a = h();`, `static uint64 h() { return_nothing(); } static void return_nothing() { }`),
    msg: /must return/i,
  },
  "non-static member call from static context": {
    // Entry bodies are static; native rejects the bare call ("call to non-static member function without an object argument").
    src: wrap(`state.mut().a = h();`, `uint64 h() { return 1; }`),
    msg: /non-static/i,
  },
  "duplicate case label": {
    src: wrap(`switch (state.get().a) { case 1: break; case 1: break; } state.mut().a = 1;`),
    msg: /duplicate case/i,
  },
  "write through state.get()": {
    // Verified divergence: the write landed on live state (read-only view aliases state).
    src: wrap(`state.get().a = 77;`),
    msg: /read-only|get\(\)/i,
  },
  "assignment to const local": {
    src: wrap(`const uint64 c = 5; c = 6; state.mut().a = c;`),
    msg: /const|read-only/i,
  },
  "address of literal": {
    src: wrap(`state.mut().a = (uint64)&5;`),
    msg: /address/i,
  },
  "constant division by zero": {
    src: wrap(`state.mut().a = state.get().a / 0;`),
    msg: /division by zero/i,
  },
  "constant modulo by zero": {
    src: wrap(`state.mut().a = state.get().a % 0;`),
    msg: /division by zero/i,
  },
  "static local variable": {
    src: wrap(`static uint64 s = 0; s = s + 1; state.mut().a = s;`),
    msg: /static local/i,
  },
  "global mutable variable": {
    src: `using namespace QPI;
uint64 g_bad = 0;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { g_bad = g_bad + 1; state.mut().a = g_bad; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`,
    msg: /global/i,
  },
  "call with too few arguments": {
    src: wrap(`state.mut().a = add(1);`, `static uint64 add(uint64 x, uint64 y) { return x + y; }`),
    msg: /argument/i,
  },
  "call with too many arguments": {
    src: wrap(`state.mut().a = add(1, 2, 3);`, `static uint64 add(uint64 x, uint64 y) { return x + y; }`),
    msg: /argument/i,
  },
  "direct recursion": {
    src: wrap(`state.mut().a = fib(5);`, `static uint64 fib(uint64 n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }`),
    msg: /recursi/i,
  },
  "mutual recursion": {
    src: wrap(`state.mut().a = pingf(3);`, `static uint64 pongf(uint64 n) { return n == 0 ? 0 : pingf(n - 1); } static uint64 pingf(uint64 n) { return n == 0 ? 1 : pongf(n - 1); }`),
    msg: /recursi/i,
  },
  "new expression": {
    src: wrap(`uint64* p = new uint64; state.mut().a = 1;`),
    msg: /allocation/i,
  },
  "delete statement": {
    src: wrap(`uint64 x = 0; uint64* p = &x; delete p; state.mut().a = 1;`),
    msg: /allocation/i,
  },
  "unknown type in local declaration": {
    src: wrap(`MysteryType q; state.mut().a = 1;`),
    msg: /unknown type/i,
  },
  "duplicate register index": {
    src: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  struct Hi_input {}; struct Hi_output {};
  PUBLIC_PROCEDURE(Go) { state.mut().a = 1; }
  PUBLIC_PROCEDURE(Hi) { state.mut().a = 2; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); REGISTER_USER_PROCEDURE(Hi, 1); }
};`,
    msg: /registered twice/i,
  },
};

const ACCEPTS: Record<string, string> = {
  "sibling scopes reuse a name": wrap(
    `uint64 t = 0; for (uint64 i = 0; i < 3; i++) { t = t + i; } for (uint64 i = 0; i < 2; i++) { t = t + i; } state.mut().a = t;`),
  "multi-declarator statement": wrap(`uint64 x = 1, y = 3; state.mut().a = x + y;`),
  "static constexpr local": wrap(`static constexpr uint64 K = 5; state.mut().a = K;`),
  "file-scope constexpr": `using namespace QPI;
constexpr uint64 G_K = 7;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { state.mut().a = G_K; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`,
  "block-scope function prototype": wrap(`uint64 h(uint64 x); state.mut().a = 1;`),
  "default argument call": wrap(`state.mut().a = add(5);`, `static uint64 add(uint64 x, uint64 y = 2) { return x + y; }`),
};

describe("semantic validation — invalid source must fail loudly", () => {
  beforeAll(async () => {
    await initK12();
  });

  for (const [name, c] of Object.entries(REJECTS)) {
    test(`rejects: ${name}`, async () => {
      const { wasm, errors } = await compile(c.src);
      if (errors.length === 0) {
        console.log(`  SILENTLY ACCEPTED (${wasm.length} bytes)`);
      }
      expect(errors.length).toBeGreaterThan(0);
      expect(wasm.length).toBe(0);
      expect(errors.some((e) => c.msg.test(e.message))).toBe(true);
    });
  }

  for (const [name, src] of Object.entries(ACCEPTS)) {
    test(`accepts: ${name}`, async () => {
      const { wasm, errors } = await compile(src);
      for (const e of errors.slice(0, 3)) {
        console.log(`  UNEXPECTED ERROR: ${e.message}`);
      }
      expect(errors).toHaveLength(0);
      expect(wasm.length).toBeGreaterThan(0);
    });
  }

  test("default arguments follow native semantics", async () => {
    const wasiOk = (() => {
      try {
        const { wasiSdkPaths } = require("@qinit/core/project");
        return existsSync(wasiSdkPaths().clang);
      } catch {
        return false;
      }
    })();
    if (!wasiOk) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const src = ACCEPTS["default argument call"];
    const dir = mkdtempSync(join(tmpdir(), "defarg-"));
    writeFileSync(join(dir, "DefArg.h"), src);
    const built = await buildContract({ contractPath: join(dir, "DefArg.h"), name: "DefArg", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
    expect(built.ok).toBe(true);
    const ours = await compile(src);
    expect(ours.errors).toHaveLength(0);

    const run = (wasm: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      const user = new Uint8Array(32).fill(7);
      sim.fund(user, 1_000_000n);
      sim.deploy(27, wasm);
      sim.procedure(27, 1, undefined, { invocator: user });
      const st = sim.contracts.get(27)!.state();
      return new DataView(st.buffer, st.byteOffset).getBigUint64(0, true);
    };

    const nat = run(new Uint8Array(readFileSync(built.so!)));
    const mine = run(ours.wasm);
    expect(nat).toBe(7n);
    expect(mine).toBe(nat);
  }, 180000);
});
