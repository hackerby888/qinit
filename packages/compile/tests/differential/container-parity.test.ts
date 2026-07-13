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
const matrix = {
  available: wasi.available && wamr.available,
  detail: `WASI: ${wasi.detail}; WAMR: ${wamr.detail}`,
  path: wamr.path,
};

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

    toolchainTest(`${fixture.family}: all compiler/runtime paths match Clang Wasm in core-lite WAMR`, matrix, () => {
      const artifacts = [
        ["TS", TS.get(fixture.family)!],
        ["Clang", NATIVE.get(fixture.family)!],
      ] as const;
      const scripts = [
        ["boundary", fixture.boundary],
        ...Array.from({ length: SEEDS }, (_, seed) => [`seed ${seed}`, seededOperations(fixture.family, seed, OPERATIONS)] as const),
      ] as const;
      for (const [scriptName, operations] of scripts) {
        const oracle = executeWamr(wamr.path!, artifacts[1][1], operations);
        for (const [compiler, artifact] of artifacts) {
          const paths = [
            [`${compiler} Wasm -> Sim`, executeContainerScript(artifact, operations)],
            [`${compiler} Wasm -> WAMR`, executeWamr(wamr.path!, artifact, operations)],
          ] as const;
          for (const [pathName, result] of paths) {
            const mismatch = compareExecutions(result, oracle);
            expect(mismatch, `${fixture.family} ${scriptName} ${pathName}: ${mismatch}`).toBeNull();
          }
        }
      }
    }, 600_000);
  }
});
