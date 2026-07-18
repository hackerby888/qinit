import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VirtualNode } from "@qinit/engine";
import { DEFAULT_WASM_SLOT_LAYOUT } from "../../src/wasm-slot-layout";
import { loadCoreWasmSlotLayout } from "../../src/wasm-slot-layout-node";
import { parseWasmSlotLayoutSource } from "../../src/wasm-slot-layout-source";

const configuredCore = process.env.QINIT_CORE?.trim();
const corePath = configuredCore ? resolve(configuredCore) : "";
const contractDefinition = join(corePath, "src", "contract_core", "contract_def.h");
const haveCore = configuredCore !== undefined && existsSync(contractDefinition);
const coreSource = haveCore ? readFileSync(contractDefinition, "utf8") : "";

describe.if(haveCore)("core-derived Wasm slot layout", () => {
  const source = coreSource;

  test("the current standard profile derives slot base 29 and count 4", () => {
    expect(loadCoreWasmSlotLayout(corePath)).toEqual({ slotBase: 29, slotCount: 4 });
  });

  test("adding a native contract shifts the dynamic base", () => {
    const extended = source.replace(
      "// new contracts should be added above this line",
      `constexpr unsigned short SYNTHETIC_CONTRACT_INDEX = CONTRACT_INDEX + 1;
#undef CONTRACT_INDEX
#define CONTRACT_INDEX SYNTHETIC_CONTRACT_INDEX
// new contracts should be added above this line`,
    );

    expect(parseWasmSlotLayoutSource(extended)).toEqual({ slotBase: 30, slotCount: 4 });
  });

  test("test-example declarations do not affect the standard profile", () => {
    const changedExamples = source.replace(
      "constexpr unsigned short TESTEXD_CONTRACT_INDEX = (CONTRACT_INDEX + 1);",
      "constexpr unsigned short TESTEXD_CONTRACT_INDEX = (CONTRACT_INDEX + 1000);",
    );

    expect(parseWasmSlotLayoutSource(changedExamples)).toEqual({ slotBase: 29, slotCount: 4 });
  });

  test.each([
    [
      "missing layout declaration",
      source.replace(
        /constexpr unsigned short WASM_RESERVED_SLOT_BASE[^;]+;\r?\n/,
        "",
      ),
    ],
    [
      "missing dynamic slot",
      source.replace(
        /constexpr unsigned short LITEDYN2_CONTRACT_INDEX[^;]+;\r?\n/,
        "",
      ),
    ],
    [
      "duplicate slot",
      source.replace(
        "constexpr unsigned short LITEDYN1_CONTRACT_INDEX",
        "constexpr unsigned short LITEDYN0_CONTRACT_INDEX",
      ),
    ],
    [
      "non-contiguous slots",
      source.replace(
        "constexpr unsigned short LITEDYN1_CONTRACT_INDEX",
        "constexpr unsigned short LITEDYN4_CONTRACT_INDEX",
      ),
    ],
    [
      "count mismatch",
      source.replace(
        "constexpr unsigned short WASM_RESERVED_SLOT_COUNT = 4;",
        "constexpr unsigned short WASM_RESERVED_SLOT_COUNT = 3;",
      ),
    ],
  ])("rejects %s", (_label, invalidSource) => {
    expect(() => parseWasmSlotLayoutSource(invalidSource)).toThrow();
  });

  test("generated defaults, the live core, runtime source, and VirtualNode agree", () => {
    const live = loadCoreWasmSlotLayout(corePath);
    const runtime = readFileSync(
      join(corePath, "src", "extensions", "wasm", "runtime", "contract_slots.h"),
      "utf8",
    );
    const node = new VirtualNode();

    expect(DEFAULT_WASM_SLOT_LAYOUT).toEqual(live);
    expect({ slotBase: node.slotBase, slotCount: node.slotCount }).toEqual(live);
    expect(runtime).toContain("return WASM_RESERVED_SLOT_BASE;");
    expect(runtime).not.toMatch(/^#define WASM_RESERVED_SLOT_COUNT/m);
  });
});
