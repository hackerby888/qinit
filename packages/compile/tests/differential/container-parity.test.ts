import { afterAll, beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE_PATH } from "../../../../test-utils/paths";
import { loadQpiHeader } from "../../src/index";
import { CONTAINER_FIXTURES } from "../support/container-fixtures";
import {
  compareExecutions,
  compileNativeFixture,
  compileTsFixture,
  executeContainerScript,
  executeWamr,
  seededOperations,
} from "../support/container-harness";
import { toolchainTest, wamrToolchain, wasiToolchain } from "../support/container-toolchains";

const ENABLED = process.env.QINIT_CONTAINER_PARITY === "1";
const SEEDS = Number(process.env.QINIT_CONTAINER_SEEDS ?? 4);
const OPERATIONS = Number(process.env.QINIT_CONTAINER_OPERATIONS ?? 64);
const TS = new Map<string, Uint8Array>();
const NATIVE = new Map<string, Uint8Array>();
const disposers: Array<() => void> = [];
const wasi = wasiToolchain();
const wamr = wamrToolchain(CORE_PATH);

beforeAll(async () => {
  if (!ENABLED) return;
  await initK12();
  const header = loadQpiHeader(CORE_PATH);
  for (const fixture of CONTAINER_FIXTURES) {
    TS.set(fixture.family, await compileTsFixture(fixture, header));
    if (wasi.available) {
      const native = await compileNativeFixture(fixture, CORE_PATH);
      NATIVE.set(fixture.family, native.wasm);
      disposers.push(native.dispose);
    }
  }
}, 600_000);

afterAll(() => {
  for (const dispose of disposers) dispose();
});

describe.skipIf(!ENABLED)(`container parity (${SEEDS} seeds x ${OPERATIONS} operations)`, () => {
  for (const fixture of CONTAINER_FIXTURES) {
    toolchainTest(`${fixture.family}: TS compiler matches native WASI after every operation and in complete state`, wasi, () => {
      const tsWasm = TS.get(fixture.family)!;
      const nativeWasm = NATIVE.get(fixture.family)!;
      const boundaryMismatch = compareExecutions(
        executeContainerScript(tsWasm, fixture.boundary),
        executeContainerScript(nativeWasm, fixture.boundary),
      );
      expect(boundaryMismatch, `${fixture.family} boundary matrix: ${boundaryMismatch}`).toBeNull();
      for (let seed = 0; seed < SEEDS; seed++) {
        const operations = seededOperations(fixture.family, seed, OPERATIONS);
        const mismatch = compareExecutions(
          executeContainerScript(tsWasm, operations),
          executeContainerScript(nativeWasm, operations),
        );
        expect(mismatch, `${fixture.family} seed ${seed}: ${mismatch}`).toBeNull();
      }
    }, 600_000);

    toolchainTest(`${fixture.family}: exact TS artifact has byte-identical final state in Sim and core-lite WAMR`, wamr, () => {
      const tsWasm = TS.get(fixture.family)!;
      expect(Buffer.from(executeWamr(wamr.path!, tsWasm, fixture.boundary)).equals(
        Buffer.from(executeContainerScript(tsWasm, fixture.boundary).state),
      ), `${fixture.family} boundary matrix final state differs`).toBe(true);
      for (let seed = 0; seed < SEEDS; seed++) {
        const operations = seededOperations(fixture.family, seed, OPERATIONS);
        const simState = executeContainerScript(tsWasm, operations).state;
        const wamrState = executeWamr(wamr.path!, tsWasm, operations);
        expect(Buffer.from(wamrState).equals(Buffer.from(simState)), `${fixture.family} seed ${seed} final state differs`).toBe(true);
      }
    }, 600_000);
  }
});
