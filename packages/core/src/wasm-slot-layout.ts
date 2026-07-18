import { WASM_SLOT_LAYOUT } from "./generated/wasm-slot-layout";
import type { WasmSlotLayout } from "./wasm-slot-layout-source";

export type { WasmSlotLayout } from "./wasm-slot-layout-source";

export const DEFAULT_WASM_SLOT_LAYOUT: Readonly<WasmSlotLayout> = Object.freeze({
  slotBase: WASM_SLOT_LAYOUT.slotBase,
  slotCount: WASM_SLOT_LAYOUT.slotCount,
});
