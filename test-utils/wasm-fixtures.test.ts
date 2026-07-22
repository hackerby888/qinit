import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "../packages/core/src/index";
import { Sim } from "../packages/engine/src/sim";
import {
  loadWasmFixture,
  wasmFixtureManifest,
  wasmFixtureNames,
} from "./wasm-fixtures";

describe("in-memory Wasm fixtures", () => {
  beforeAll(async () => {
    await initK12();
  });

  test(
    "every manifest entry compiles to a valid module with its declared slot",
    async () => {
      for (const name of wasmFixtureNames) {
        const definition = wasmFixtureManifest[name];
        const wasm = await loadWasmFixture(name);

        expect(WebAssembly.validate(wasm)).toBe(true);

        const contract = new Sim().deploy(definition.slot, wasm);
        expect(contract.ex.contract_index()).toBe(definition.slot);
      }
    },
    120_000,
  );

  test("Proxy derives its callee ABI from the generated slot-28 Counter", async () => {
    expect(wasmFixtureManifest.Proxy.dependencies).toEqual(["Counter"]);

    const sim = new Sim();
    sim.deploy(28, await loadWasmFixture("Counter"));
    sim.deploy(29, await loadWasmFixture("Proxy"));
    sim.procedure(29, 1);

    const result = sim.query(29, 1);
    const value = new DataView(
      result.buffer,
      result.byteOffset,
      result.byteLength,
    ).getBigUint64(0, true);
    expect(value).toBe(1n);
  });

  test("OracleProbe compiles from the pinned browser snapshot", async () => {
    const wasm = await loadWasmFixture("OracleProbe");

    expect(WebAssembly.validate(wasm)).toBe(true);
    expect(new Sim().deploy(29, wasm).ex.contract_index()).toBe(29);
  });

  test("each caller receives an independent byte copy", async () => {
    const first = await loadWasmFixture("Counter");
    const second = await loadWasmFixture("Counter");
    const original = second[0];

    expect(first).not.toBe(second);
    expect(first.buffer).not.toBe(second.buffer);

    first[0] ^= 0xff;
    expect(second[0]).toBe(original);
  });
});
