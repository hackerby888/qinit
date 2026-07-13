import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLiteAbiSource, type LiteAbiSource } from "./lite-abi-source";

/** Read ABI metadata from the selected live core-lite checkout. */
export function loadLiteAbiSource(corePath: string): LiteAbiSource {
  const extensionDir = join(corePath, "src", "extensions");
  return parseLiteAbiSource(
    readFileSync(join(extensionDir, "lite_abi_metadata.h"), "utf8"),
    readFileSync(join(extensionDir, "lite_dyn_abi.h"), "utf8"),
  );
}
