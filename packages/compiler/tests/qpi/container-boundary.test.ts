import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE_PATH } from "../../../../test-utils/paths";
import { loadQpiHeader } from "../../src/index";
import { CONTAINER_FIXTURES } from "../support/container-fixtures";
import {
  compileTsFixture,
  decodeWords,
  executeContainerScript,
} from "../support/container-harness";

const compiled = new Map<string, Uint8Array>();

beforeAll(async () => {
  await initK12();
  const header = loadQpiHeader(CORE_PATH);
  for (const fixture of CONTAINER_FIXTURES)
    compiled.set(fixture.family, await compileTsFixture(fixture, header));
});

const U64_NEGATIVE_ONE = 0xffff_ffff_ffff_ffffn;

describe("deterministic QPI container boundary matrix", () => {
  for (const fixture of CONTAINER_FIXTURES) {
    test(`${fixture.family} compiles once and executes its complete boundary script`, () => {
      const wasm = compiled.get(fixture.family)!;
      expect(WebAssembly.validate(wasm)).toBe(true);
      const result = executeContainerScript(wasm, fixture.boundary);
      expect(result.outputs).toHaveLength(fixture.boundary.length);
      expect(result.state.byteLength).toBeGreaterThan(0);
      expect(result.outputs.every((output) => output.byteLength === 32)).toBe(true);
    });
  }

  test("Array covers capacity, wrapping, ranges, memory copy, aggregates, and assignment", () => {
    const fixture = CONTAINER_FIXTURES.find((item) => item.family === "Array")!;
    const output = executeContainerScript(compiled.get("Array")!, fixture.boundary).outputs.map(
      decodeWords,
    );
    expect(output[0]).toEqual([8n, 9n, 9n, 0n]);
    expect(output[1].slice(0, 2)).toEqual([17n, 17n]);
    expect(output[2].slice(0, 2)).toEqual([23n, 23n]);
    expect(output[5][0]).toBe(1n);
    expect(output[6][0]).toBe(0n);
    expect(output[7][0]).toBe(0n);
    expect(output[8][0]).toBe(1n);
    expect(output[9].slice(0, 2)).toEqual([55n, 66n]);
    expect(output[10].slice(0, 2)).toEqual([17n, 23n]);
  });

  test("BitArray covers all capacities, word edges, wrapping, fills, setMem, and equality", () => {
    const fixture = CONTAINER_FIXTURES.find((item) => item.family === "BitArray")!;
    const output = executeContainerScript(compiled.get("BitArray")!, fixture.boundary).outputs.map(
      decodeWords,
    );
    expect(output[0].slice(0, 2)).toEqual([1n, 2n]);
    expect(output[2].slice(0, 2)).toEqual([1n, 64n]);
    expect(output[4].slice(0, 2)).toEqual([1n, 128n]);
    expect(output[7].slice(0, 2)).toEqual([1n, 4096n]);
    expect(output[10].slice(0, 2)).toEqual([1n, 0n]);
    expect(output[12].slice(0, 2)).toEqual([0n, 1n]);
    expect(output[13].slice(0, 2)).toEqual([1n, 1n]);
    expect(output[14].slice(0, 3)).toEqual([1n, 1n, 1n]);
  });

  test("HashMap and HashSet cover collisions, overwrite/duplicate, full capacity, removal, cleanup, and reset", () => {
    const mapFixture = CONTAINER_FIXTURES.find((item) => item.family === "HashMap")!;
    const setFixture = CONTAINER_FIXTURES.find((item) => item.family === "HashSet")!;
    const map = executeContainerScript(compiled.get("HashMap")!, mapFixture.boundary).outputs.map(
      decodeWords,
    );
    const set = executeContainerScript(compiled.get("HashSet")!, setFixture.boundary).outputs.map(
      decodeWords,
    );
    expect(map[0][0]).toBe(16n);
    expect(map[5][1]).toBe(3n);
    expect(map[6].slice(0, 3)).toEqual([1n, 22n, 1n]);
    expect(map[21][0]).toBe(U64_NEGATIVE_ONE);
    expect(map[26][0]).toBe(1n);
    expect(map.at(-1)![0]).toBe(0n);
    expect(set[2].slice(0, 2)).toEqual([15n, 15n]);
    expect(set[18][0]).toBe(U64_NEGATIVE_ONE);
    expect(set[23][0]).toBe(1n);
    expect(set.at(-1)![0]).toBe(0n);
  });

  test("Collection covers colliding PoVs, filtered traversal, invalid operations, full capacity, cleanup, rebuild, and reset", () => {
    const fixture = CONTAINER_FIXTURES.find((item) => item.family === "Collection")!;
    const output = executeContainerScript(
      compiled.get("Collection")!,
      fixture.boundary,
    ).outputs.map(decodeWords);
    expect(output[0].slice(0, 2)).toEqual([0n, 16n]);
    expect(output[6]).toEqual([0n, 0n, 2n, 1n]);
    expect(output[7][0]).toBe(3n);
    expect(output[8][0]).toBe(3n);
    expect(output[9].slice(0, 2)).toEqual([0x9358942en, 5n]);
    expect(output[12][0]).toBe(U64_NEGATIVE_ONE);
    expect(output[30][0]).toBe(U64_NEGATIVE_ONE);
    expect(output[32].slice(0, 2)).toEqual([0n, 16n]);
    expect(output.at(-1)![0]).toBe(48n);
  });

  test("LinkedList covers empty/singleton, insertion, traversal, invalid operations, full capacity, reuse, and reset", () => {
    const fixture = CONTAINER_FIXTURES.find((item) => item.family === "LinkedList")!;
    const output = executeContainerScript(
      compiled.get("LinkedList")!,
      fixture.boundary,
    ).outputs.map(decodeWords);
    expect(output[0].slice(0, 3)).toEqual([0n, U64_NEGATIVE_ONE, U64_NEGATIVE_ONE]);
    expect(output[1]).toEqual([1n, U64_NEGATIVE_ONE, U64_NEGATIVE_ONE, 8n]);
    expect(output[6][0]).toBe(U64_NEGATIVE_ONE);
    expect(output[8][0]).toBe(4n);
    expect(output[10][0]).toBe(1n);
    expect(output[11][0]).toBe(0n);
    expect(output[18][0]).toBe(U64_NEGATIVE_ONE);
    expect(output[20][0]).toBe(7n);
    expect(output[21][0]).toBe(1n);
    expect(output.at(-1)!.slice(0, 3)).toEqual([0n, U64_NEGATIVE_ONE, U64_NEGATIVE_ONE]);
  });
});
