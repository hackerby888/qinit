import { CORE_PATH } from "../../../../test-utils/paths";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ENUMERATION_RECORD, LHOST_ABI, loadLiteAbiSource } from "@qinit/core";
import { emitModule } from "../../src/framework";
import { inspectLiteWasmModule } from "../../src/compiler/wasm-inspect";
import { QPI_CONTEXT_LAYOUT } from "../support/qpi-context-layout";

const CORE = CORE_PATH;
const metadataHeader = join(CORE, "src/extensions/lite_abi_metadata.h");

describe("shared lhost ABI", () => {
  test.if(existsSync(metadataHeader))("matches core-lite's generated canonical metadata", () => {
    const rows = loadLiteAbiSource(CORE).lhost;
    expect(rows.map(({ name }) => name)).toEqual(Object.keys(LHOST_ABI));
    const manifest = Object.fromEntries(
      Object.entries(LHOST_ABI).map(([name, abi]) => [
        name,
        {
          params: [...abi.params],
          results: [...abi.results],
        },
      ]),
    );
    expect(
      Object.fromEntries(rows.map(({ name, params, results }) => [name, { params, results }])),
    ).toEqual(manifest);
  });

  test("framework imports cover the manifest exactly", async () => {
    const wat = emitModule({
      stateSize: 0,
      arenaSize: 64 * 1024,
      contextLayout: QPI_CONTEXT_LAYOUT,
      entries: [],
      sysprocs: [],
      userFunctionsWat: ";; none",
    });
    const wabt = await import("wabt");
    const api = await wabt.default();
    const parsed = api.parseWat("lhost-abi.test.wat", wat);
    try {
      const wasm = new Uint8Array(parsed.toBinary({}).buffer);
      const imports = inspectLiteWasmModule(wasm).imports.filter(
        (entry) => entry.module === "lhost",
      );
      expect(imports.map((entry) => entry.name)).toEqual(Object.keys(LHOST_ABI));
      expect(Object.fromEntries(imports.map((entry) => [entry.name, entry.signature]))).toEqual(
        LHOST_ABI,
      );
    } finally {
      parsed.destroy();
    }
  });

  test.if(existsSync(metadataHeader))(
    "asset enumeration layout comes from core-lite's named exchange record",
    () => {
      const source = loadLiteAbiSource(CORE).records.LiteAssetEntry;
      expect(source.size).toBe(ASSET_ENUMERATION_RECORD.size);
      expect(source.capacity).toBe(ASSET_ENUMERATION_RECORD.capacity);
      expect(ASSET_ENUMERATION_RECORD).toMatchObject({
        size: 80,
        fields: {
          owner: { offset: 0, size: 32 },
          possessor: { offset: 32, size: 32 },
          shares: { offset: 64, size: 8 },
          ownershipManagingContract: { offset: 72, size: 2 },
          possessionManagingContract: { offset: 74, size: 2 },
        },
      });
    },
  );
});
