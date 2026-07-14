import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLiteAbiSource, type LiteAbiSource } from "./lite-abi-source";

/** Read ABI metadata from the selected live core-lite checkout. */
export function loadLiteAbiSource(corePath: string): LiteAbiSource {
  const wasmExtensionDir = join(corePath, "src", "extensions", "wasm");
  return parseLiteAbiSource(
    readFileSync(join(wasmExtensionDir, "lite_abi_metadata.h"), "utf8"),
    readFileSync(join(wasmExtensionDir, "lite_dyn_abi.h"), "utf8"),
  );
}
