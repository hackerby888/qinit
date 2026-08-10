import { describe, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import { bytesToIdentity, initK12 } from "@qinit/core";
import {
  AbiTypeKind,
  createQpiContainerView,
  qpiSnapshotSource,
  type ContractIdl,
  type QpiContainerView,
} from "@qinit/proto";
import { CORE_PATH } from "../../../../test-utils/paths";
import { loadQpiHeader } from "../../src/index";
import { CONTAINER_FIXTURES } from "../support/container-fixtures";
import {
  CONTAINER_SLOT,
  compileClangFixture,
  decodeWords,
  executeWamr,
} from "../support/container-harness";
import {
  toolchainTest,
  wamrToolchain,
  wasiToolchain,
} from "../support/container-toolchains";

const ENABLED = process.env.QINIT_CONTAINER_PARITY === "1";
const CHECKPOINT_OPERATIONS: Record<string, number> = {
  Array: 12,
  BitArray: 14,
  HashMap: 26,
  HashSet: 23,
  Collection: 6,
  LinkedList: 6,
};
const wasi = wasiToolchain();
const wamr = wamrToolchain(CORE_PATH);
const matrix = {
  available: wasi.available && wamr.available,
  detail: `WASI: ${wasi.detail}; WAMR: ${wamr.detail}`,
  path: wamr.path,
};

describe.skipIf(!ENABLED)("native QPI container view oracle", () => {
  toolchainTest(
    "decodes exact Clang/WAMR container contents, populations, and order",
    matrix,
    async () => {
      await initK12();
      const qpiHeader = loadQpiHeader(CORE_PATH);
      const pov1 = await identityWithLane0(1n);
      const pov17 = await identityWithLane0(17n);
      const pov33 = await identityWithLane0(33n);

      for (const fixture of CONTAINER_FIXTURES) {
        const operationCount = CHECKPOINT_OPERATIONS[fixture.family];
        if (operationCount === undefined) {
          throw new Error(`No native checkpoint for ${fixture.family}`);
        }

        const clangBuild = await compileClangFixture(fixture, CORE_PATH);
        try {
          const execution = executeWamr(
            matrix.path!,
            clangBuild.wasm,
            fixture.boundary.slice(0, operationCount),
          );
          expect(
            execution.operations.every((operation) => operation.status === "ok"),
            `${fixture.family} native checkpoint must complete`,
          ).toBe(true);

          const idl = extractIdl(fixture.source, fixture.name, {
            slot: CONTAINER_SLOT,
            qpiHeader,
          });
          const outputWords = decodeWords(execution.outputs.at(-1)!);

          switch (fixture.family) {
            case "Array": {
              const view = stateContainerView(idl, execution.state, "pairs");
              if (view.kind !== AbiTypeKind.ARRAY) {
                throw new Error("Array fixture field has the wrong ABI kind");
              }
              expect(view.capacity).toBe(4);
              expect(await view.entries()).toEqual([
                { index: 0, value: [0n, 0n], isZeroBytes: true },
                { index: 1, value: [55n, 66n], isZeroBytes: false },
                { index: 2, value: [0n, 0n], isZeroBytes: true },
                { index: 3, value: [0n, 0n], isZeroBytes: true },
              ]);
              break;
            }
            case "BitArray": {
              const view = stateContainerView(idl, execution.state, "b64");
              if (view.kind !== AbiTypeKind.BIT_ARRAY) {
                throw new Error("BitArray fixture field has the wrong ABI kind");
              }
              const setBits: number[] = [];
              for await (const index of view.setBits()) {
                setBits.push(index);
              }
              expect(view.capacity).toBe(64);
              expect(setBits).toEqual([0, 63]);
              expect(outputWords.slice(0, 2)).toEqual([1n, 1n]);
              break;
            }
            case "HashMap": {
              const view = stateContainerView(idl, execution.state, "map");
              if (view.kind !== AbiTypeKind.HASH_MAP) {
                throw new Error("HashMap fixture field has the wrong ABI kind");
              }
              const entries = await view.entries();
              expect(view.capacity).toBe(16);
              expect(entries).toEqual([
                { slot: 0, key: 31n, value: 22n },
                { slot: 1, key: 47n, value: 30n },
                { slot: 2, key: 111n, value: 11n },
                { slot: 4, key: 100n, value: 0n },
                { slot: 5, key: 101n, value: 1n },
                { slot: 6, key: 102n, value: 2n },
                { slot: 7, key: 103n, value: 3n },
                { slot: 8, key: 104n, value: 4n },
                { slot: 9, key: 105n, value: 5n },
                { slot: 10, key: 106n, value: 6n },
                { slot: 11, key: 107n, value: 7n },
                { slot: 12, key: 108n, value: 8n },
                { slot: 13, key: 109n, value: 9n },
                { slot: 14, key: 110n, value: 10n },
                { slot: 15, key: 63n, value: 40n },
              ]);
              expect(outputWords[1]).toBe(BigInt(entries.length));
              break;
            }
            case "HashSet": {
              const view = stateContainerView(idl, execution.state, "set");
              if (view.kind !== AbiTypeKind.HASH_SET) {
                throw new Error("HashSet fixture field has the wrong ABI kind");
              }
              const entries = await view.entries();
              expect(view.capacity).toBe(16);
              expect(entries).toEqual([
                { slot: 0, key: 31n },
                { slot: 1, key: 47n },
                { slot: 2, key: 111n },
                { slot: 4, key: 100n },
                { slot: 5, key: 101n },
                { slot: 6, key: 102n },
                { slot: 7, key: 103n },
                { slot: 8, key: 104n },
                { slot: 9, key: 105n },
                { slot: 10, key: 106n },
                { slot: 11, key: 107n },
                { slot: 12, key: 108n },
                { slot: 13, key: 109n },
                { slot: 14, key: 110n },
                { slot: 15, key: 63n },
              ]);
              expect(outputWords[1]).toBe(BigInt(entries.length));
              break;
            }
            case "Collection": {
              const view = stateContainerView(idl, execution.state, "collection");
              if (view.kind !== AbiTypeKind.COLLECTION) {
                throw new Error("Collection fixture field has the wrong ABI kind");
              }
              const entries = await view.entries();
              expect(view.capacity).toBe(16);
              expect(entries).toEqual([
                {
                  povSlot: 1,
                  elementIndex: 0,
                  pov: pov1,
                  priority: 5n,
                  value: 0x9358942en,
                },
                {
                  povSlot: 1,
                  elementIndex: 1,
                  pov: pov1,
                  priority: 5n,
                  value: 20n,
                },
                {
                  povSlot: 1,
                  elementIndex: 2,
                  pov: pov1,
                  priority: -1n,
                  value: 30n,
                },
                {
                  povSlot: 2,
                  elementIndex: 3,
                  pov: pov17,
                  priority: 7n,
                  value: 40n,
                },
                {
                  povSlot: 3,
                  elementIndex: 4,
                  pov: pov33,
                  priority: 9n,
                  value: 50n,
                },
              ]);
              expect(outputWords.slice(0, 3)).toEqual([4n, 5n, 1n]);
              expect(outputWords[1]).toBe(BigInt(entries.length));
              break;
            }
            case "LinkedList": {
              const view = stateContainerView(idl, execution.state, "list");
              if (view.kind !== AbiTypeKind.LINKED_LIST) {
                throw new Error("LinkedList fixture field has the wrong ABI kind");
              }
              const entries = await view.entries();
              expect(view.capacity).toBe(8);
              expect(entries).toEqual([
                { slot: 1, value: 20n },
                { slot: 3, value: 40n },
                { slot: 0, value: 10n },
                { slot: 2, value: 30n },
              ]);
              expect(outputWords.slice(0, 2)).toEqual([3n, 4n]);
              expect(outputWords[1]).toBe(BigInt(entries.length));
              break;
            }
            default:
              throw new Error(`No view oracle for ${fixture.family}`);
          }
        } finally {
          clangBuild.dispose();
        }
      }
    },
    600_000,
  );
});

function stateContainerView(
  idl: ContractIdl,
  state: Uint8Array,
  fieldName: string,
): QpiContainerView {
  const field = idl.state.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(`State field '${fieldName}' is missing from the IDL`);
  }
  const source = qpiSnapshotSource(
    state.slice(field.offset, field.offset + field.size),
  );
  switch (field.type.kind) {
    case AbiTypeKind.ARRAY:
    case AbiTypeKind.BIT_ARRAY:
    case AbiTypeKind.HASH_MAP:
    case AbiTypeKind.HASH_SET:
    case AbiTypeKind.COLLECTION:
    case AbiTypeKind.LINKED_LIST:
      return createQpiContainerView(field.type, source);
    default:
      throw new Error(`State field '${fieldName}' is not a QPI container`);
  }
}

async function identityWithLane0(value: bigint): Promise<string> {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return await bytesToIdentity(bytes);
}
