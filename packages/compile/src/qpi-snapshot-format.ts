import type { WasmAbiSource } from "@qinit/core/wasm-abi-source";

// v10 derives compiler-visible protocol declarations from core-lite common_def.h.
export const GENERATOR_VERSION = 10;

export const IMPL_BOUNDARY = "//__QINIT_IMPL_BOUNDARY__";
export const WASM_ABI_MARKER = "//__QINIT_WASM_ABI__";

export function embeddedWasmAbi(headers: string): WasmAbiSource {
  const line = headers.split(/\r?\n/).find((value) => value.startsWith(WASM_ABI_MARKER));
  if (!line) throw new Error("QPI headers are missing embedded core ABI metadata");
  return JSON.parse(line.slice(WASM_ABI_MARKER.length)) as WasmAbiSource;
}
