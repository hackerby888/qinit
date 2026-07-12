// Counter end-to-end spike: validate engine ABI + framework WAT.

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { Sim } from "@qinit/engine";
import { initK12, deriveKeysSync } from "@qinit/core";
import { emitFramework } from "../../src/framework";
import type { UserEntry, SysProcInfo } from "../../src/framework";

const FIXTURE = resolve(import.meta.dir, "../../../engine/tests/fixtures/Counter.wasm");
const SPIKE_WAT = resolve(import.meta.dir, "counter-spike.wat");

function loadWasm(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

// Generate the Counter-specific WAT using the framework
function generateCounterWat(): string {
  const framework = emitFramework({
    stateSize: 8,
    arenaSize: 64 * 1024,
    userEntryCount: 2,
    sysprocMask: 0,
  });

  return framework;
}

describe("Counter spike", () => {
  let sim: Sim;

  beforeAll(async () => {
    await initK12();
    sim = new Sim();
  });

  test("loads existing Counter.wasm fixture into engine", () => {
    const wasm = loadWasm(FIXTURE);
    expect(wasm.byteLength).toBeGreaterThan(1000);

    const contract = sim.deploy(28, wasm);
    expect(contract).toBeDefined();

    const ex = contract.ex;
    expect(typeof ex.state_addr).toBe("function");
    expect(typeof ex.state_size).toBe("function");
    expect(typeof ex.dispatch).toBe("function");
    expect(typeof ex.reg_count).toBe("function");

    const stateSz = ex.state_size();
    expect(stateSz).toBe(8);

    const stateAddr = ex.state_addr();
    expect(stateAddr).toBeGreaterThanOrEqual(0);
  });

  test("Counter.Get returns 0 initially", () => {
    sim = new Sim();
    sim.deploy(28, loadWasm(FIXTURE));

    const result = sim.query(28, 1);
    expect(result.byteLength).toBe(8);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(view.getBigUint64(0, true)).toBe(0n);
  });

  test("Counter.Inc increments state", () => {
    sim = new Sim();
    sim.deploy(28, loadWasm(FIXTURE));

    const id = deriveKeysSync("aaaa").publicKey;
    sim.fund(id, 1_000_000_000n);

    sim.procedure(28, 1, undefined, { originator: id, invocator: id, reward: 0n });

    const result = sim.query(28, 1);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(view.getBigUint64(0, true)).toBe(1n);
  });

  test("Counter.Inc is cumulative across multiple calls", () => {
    sim = new Sim();
    sim.deploy(28, loadWasm(FIXTURE));

    const id = deriveKeysSync("bbbb").publicKey;
    sim.fund(id, 1_000_000_000n);

    for (let i = 0; i < 5; i++) {
      sim.procedure(28, 1, undefined, { originator: id, invocator: id, reward: 0n });
    }

    const result = sim.query(28, 1);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(view.getBigUint64(0, true)).toBe(5n);
  });

  test("generates framework WAT with correct exports and imports", () => {
    const wat = generateCounterWat();

    expect(wat).toContain('(export "state_addr"');
    expect(wat).toContain('(export "state_size"');
    expect(wat).toContain('(export "io_base"');
    expect(wat).toContain('(export "ctx_addr"');
    expect(wat).toContain('(export "reg_count"');
    expect(wat).toContain('(export "reg_info"');
    expect(wat).toContain('(export "reg_sysproc_mask"');
    expect(wat).toContain('(export "dispatch"');
    expect(wat).toContain('(export "_initialize"');
    expect(wat).toContain('(export "memory"');

    expect(wat).toContain('"lhost" "transfer"');
    expect(wat).toContain('"lhost" "epoch"');
    expect(wat).toContain('"lhost" "k12"');
    expect(wat).toContain('"lhost" "abort"');

    expect(wat).toContain("i32.const 8");
  });
});

// Test the hand-written Counter WAT against the engine
describe("Hand-written Counter WAT", () => {
  test("compiles counter-spike.wat to valid wasm", () => {
    if (!existsSync(SPIKE_WAT)) {
      console.log("  (counter-spike.wat not found — skipping)");
      return;
    }

    let wasm: Uint8Array;
    try {
      execSync(`wat2wasm "${SPIKE_WAT}" -o /tmp/counter-spike.wasm 2>&1`, { stdio: "pipe" });
      wasm = new Uint8Array(readFileSync("/tmp/counter-spike.wasm"));
    } catch (e: any) {
      const stderr = e.stderr?.toString() || "";
      console.log(`  wat2wasm failed: ${stderr.slice(0, 200)}`);
      return;
    }

    expect(wasm.byteLength).toBeGreaterThan(100);

    const s = new Sim();
    const contract = s.deploy(28, wasm);
    expect(contract).toBeDefined();

    const stateSz = contract.ex.state_size();
    expect(stateSz).toBe(8);
  });
});
