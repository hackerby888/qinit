import { DEFAULT_WASM_SLOT_LAYOUT, loadCoreWasmSlotLayout, type WasmSlotLayout } from "@qinit/core";
import { CORE_PATH, HAS_CORE } from "./paths";

/** The dynamic slot window the way a node derives it: from the live core headers, with the generated browser default only when no checkout is present. */
export const TEST_SLOT_LAYOUT: WasmSlotLayout = HAS_CORE ? loadCoreWasmSlotLayout(CORE_PATH) : DEFAULT_WASM_SLOT_LAYOUT;
