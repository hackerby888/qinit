import { CORE_PATH } from "../../../../test-utils/paths";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_ENUMERATION_RECORD, LHOST_ABI } from "@qinit/core";
import { emitModule } from "../../src/framework";
import { inspectLiteWasmModule } from "../../src/compiler/wasm-inspect";

const CORE = CORE_PATH;
const importsHeader = join(CORE, "src/extensions/lite_wasm_imports.h");
const dynamicHeader = join(CORE, "src/extensions/lite_dynamic_contracts.h");

function coreSignature(text: string): { params: string[]; results: string[] } {
  const match = /^\(([^)]*)\)(.*)$/.exec(text);
  if (!match) throw new Error(`invalid core-lite WAMR signature '${text}'`);
  const type = (char: string) => char === "i" ? "i32" : char === "I" ? "i64" : (() => { throw new Error(`unsupported core-lite WAMR type '${char}'`); })();
  return { params: [...match[1]].map(type), results: [...match[2]].map(type) };
}

describe("shared lhost ABI", () => {
  test.if(existsSync(importsHeader))("matches core-lite's canonical LHOST_TABLE independently", () => {
    const source = readFileSync(importsHeader, "utf8");
    const table = source.slice(source.indexOf("#define LHOST_TABLE"), source.indexOf("#define LHOST_AS_GQ"));
    const rows = [...table.matchAll(/\b(?:GQ|GI|HQ|HI)\(\s*"([^"]+)"[^\n]*?"(\([iI]*\)[iI]?)"\s*\)/g)]
      .map((match) => [match[1], coreSignature(match[2])] as const);
    expect(rows.map(([name]) => name)).toEqual(Object.keys(LHOST_ABI));
    const manifest = Object.fromEntries(Object.entries(LHOST_ABI).map(([name, abi]) => [name, {
      params: [...abi.params],
      results: [...abi.results],
    }]));
    expect(Object.fromEntries(rows)).toEqual(manifest);
  });

  test("framework imports cover the manifest exactly", async () => {
    const wat = emitModule({ stateSize: 0, arenaSize: 64 * 1024, entries: [], sysprocs: [], userFunctionsWat: ";; none" });
    const wabt = await import("wabt");
    const api = await wabt.default();
    const parsed = api.parseWat("lhost-abi.test.wat", wat);
    try {
      const wasm = new Uint8Array(parsed.toBinary({}).buffer);
      const imports = inspectLiteWasmModule(wasm).imports.filter((entry) => entry.module === "lhost");
      expect(imports.map((entry) => entry.name)).toEqual(Object.keys(LHOST_ABI));
      expect(Object.fromEntries(imports.map((entry) => [entry.name, entry.signature]))).toEqual(LHOST_ABI);
    } finally {
      parsed.destroy();
    }
  });

  test.if(existsSync(dynamicHeader))("asset enumeration layout matches core-lite's host adapter", () => {
    const source = readFileSync(dynamicHeader, "utf8");
    expect(source).toContain("unsigned char owner[32]; unsigned char possessor[32]; long long shares; unsigned short ownMgmt; unsigned short posMgmt; unsigned char pad[4]");
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
  });
});
