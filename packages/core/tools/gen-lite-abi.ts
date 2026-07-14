import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseLiteAbiSource } from "../src/lite-abi-source";

const args = process.argv.slice(2);
const coreIndex = args.indexOf("--core");
const coreArg = (coreIndex >= 0 ? args[coreIndex + 1] : undefined) ?? process.env.QINIT_CORE;
if (!coreArg) throw new Error("pass --core <core-lite checkout> or set QINIT_CORE");
const core = resolve(coreArg);
const metadataPath = join(core, "src", "extensions", "wasm", "lite_abi_metadata.h");
const sharedPath = join(core, "src", "extensions", "wasm", "lite_dyn_abi.h");
const metadata = parseLiteAbiSource(readFileSync(metadataPath, "utf8"), readFileSync(sharedPath, "utf8"));
const out = resolve(import.meta.dir, "..", "src", "generated", "lite-abi.ts");
const generated =
  "// Generated from core-lite src/extensions/wasm/lite_abi_metadata.h and lite_dyn_abi.h. Do not edit.\n" +
  `export const LITE_ABI_METADATA = ${JSON.stringify(metadata, null, 2)} as const;\n`;
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
