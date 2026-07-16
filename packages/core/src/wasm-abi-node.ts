import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "./wasm-headers";
import { parseWasmAbiSource, type WasmAbiSource } from "./wasm-abi-source";

/** Read ABI metadata from the selected live core-lite checkout. */
export function loadWasmAbiSource(corePath: string): WasmAbiSource {
  const sourceDirectory = join(corePath, "src");
  return parseWasmAbiSource(
    readFileSync(join(sourceDirectory, CORE_WASM_HEADERS.shared.abiMetadata), "utf8"),
    readFileSync(join(sourceDirectory, CORE_WASM_HEADERS.shared.abiTypes), "utf8"),
  );
}
