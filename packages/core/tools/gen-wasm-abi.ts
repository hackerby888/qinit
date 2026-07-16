import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CORE_WASM_HEADERS } from "../src/wasm-headers";
import { parseWasmAbiSource } from "../src/wasm-abi-source";

const args = process.argv.slice(2);
const coreIndex = args.indexOf("--core");
const coreArg = (coreIndex >= 0 ? args[coreIndex + 1] : undefined) ?? process.env.QINIT_CORE;
if (!coreArg) throw new Error("pass --core <core-lite checkout> or set QINIT_CORE");
const core = resolve(coreArg);
const metadataPath = join(core, "src", CORE_WASM_HEADERS.shared.abiMetadata);
const sharedPath = join(core, "src", CORE_WASM_HEADERS.shared.abiTypes);
const metadata = parseWasmAbiSource(
  readFileSync(metadataPath, "utf8"),
  readFileSync(sharedPath, "utf8"),
);
const out = resolve(import.meta.dir, "..", "src", "generated", "wasm-abi.ts");
const generated =
  "// Generated from core-lite Wasm shared ABI headers. Do not edit.\n" +
  `export const WASM_ABI_METADATA = ${JSON.stringify(metadata, null, 2)} as const;\n`;
if (args.includes("--check")) {
  if (!existsSync(out) || readFileSync(out, "utf8") !== generated) {
    throw new Error(`${out} is stale; regenerate it from ${core}`);
  }
  console.log(`${out} is current`);
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, generated);
console.log(out);
