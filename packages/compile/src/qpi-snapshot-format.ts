import type { WasmAbiSource } from "@qinit/core/wasm-abi-source";

// v8 embeds the slot-identifying Wasm ABI v2 metadata.
export const GENERATOR_VERSION = 8;

export const IMPL_BOUNDARY = "//__QINIT_IMPL_BOUNDARY__";
export const WASM_ABI_MARKER = "//__QINIT_WASM_ABI__";

export function embeddedWasmAbi(headers: string): WasmAbiSource {
  const line = headers.split(/\r?\n/).find((value) => value.startsWith(WASM_ABI_MARKER));
  if (!line) throw new Error("QPI headers are missing embedded core ABI metadata");
  return JSON.parse(line.slice(WASM_ABI_MARKER.length)) as WasmAbiSource;
}
