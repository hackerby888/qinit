import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWasmSlotLayoutSource,
  type WasmSlotLayout,
} from "./wasm-slot-layout-source";

/** Read the dynamic Wasm slot window from the selected live core-lite checkout. */
export function loadCoreWasmSlotLayout(corePath: string): WasmSlotLayout {
  return parseWasmSlotLayoutSource(
    readFileSync(join(corePath, "src", "contract_core", "contract_def.h"), "utf8"),
  );
}
