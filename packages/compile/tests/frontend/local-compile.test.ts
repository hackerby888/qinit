// Verify locally-compiled Counter.wasm works in the engine
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { Sim } from "@qinit/engine";
import { initK12, deriveKeysSync } from "@qinit/core";
import { compileContract, QPI_STUB } from "../../src/index";

const COUNTER_SRC = readFileSync(new URL("../../../../fixtures/Counter.h", import.meta.url), "utf8");

beforeAll(async () => {
  await initK12();
});

describe("Local Counter compilation", () => {
  test("compiles Counter.h with zero errors", async () => {
    const r = await compileContract({ source: COUNTER_SRC, name: "Counter", slot: 28, qpiHeader: QPI_STUB });
    expect(r.diagnostics).toHaveLength(0);
    expect(r.wasm.byteLength).toBeGreaterThan(100);
  });

  test("compiled Counter loads in engine with correct state_size", async () => {
    const r = await compileContract({ source: COUNTER_SRC, name: "Counter", slot: 28, qpiHeader: QPI_STUB });
    const sim = new Sim();
    const c = sim.deploy(28, r.wasm);
    expect(typeof c.ex.dispatch).toBe("function");
    expect(c.ex.state_size()).toBe(8);
  });

  test("Get returns 0 initially", async () => {
    const r = await compileContract({ source: COUNTER_SRC, name: "Counter", slot: 28, qpiHeader: QPI_STUB });
    const sim = new Sim();
    sim.deploy(28, r.wasm);
    const result = sim.query(28, 1);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(view.getBigUint64(0, true)).toBe(0n);
  });

  test("Inc increments then Get returns 1", async () => {
    const r = await compileContract({ source: COUNTER_SRC, name: "Counter", slot: 28, qpiHeader: QPI_STUB });
    const sim = new Sim();
    sim.deploy(28, r.wasm);
    const id = deriveKeysSync("aaaa").publicKey;
    sim.fund(id, 1_000_000_000n);
    sim.procedure(28, 1, undefined, { originator: id, invocator: id, reward: 0n });

    const result = sim.query(28, 1);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(view.getBigUint64(0, true)).toBe(1n);
  });
});
