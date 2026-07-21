import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CORE_WASM_HEADERS } from "../src/wasm-headers";
import { parseWasmAbiSource } from "../src/wasm-abi-source";
import { parseWasmSlotLayoutSource } from "../src/wasm-slot-layout-source";

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
const abiOutput = resolve(import.meta.dir, "..", "src", "generated", "wasm-abi.ts");
const generatedAbi =
  "// Generated from core-lite Wasm shared ABI headers. Do not edit.\n" +
  `export const WASM_ABI_METADATA = ${JSON.stringify(metadata, null, 2)} as const;\n`;
const slotLayout = parseWasmSlotLayoutSource(
  readFileSync(join(core, "src", "contract_core", "contract_def.h"), "utf8"),
);
const layoutOutput = resolve(
  import.meta.dir,
  "..",
  "src",
  "generated",
  "wasm-slot-layout.ts",
);
const generatedLayout =
  "// Generated from core-lite's standard lite-Wasm contract profile. Do not edit.\n" +
  `export const WASM_SLOT_LAYOUT = ${JSON.stringify(slotLayout, null, 2)} as const;\n`;
const outputs = [
  { path: abiOutput, contents: generatedAbi },
  { path: layoutOutput, contents: generatedLayout },
];
const normalize = (source: string) => source.replace(/\r\n?/g, "\n");
if (args.includes("--check")) {
  const stale = outputs.find(
    (output) =>
      !existsSync(output.path) ||
      normalize(readFileSync(output.path, "utf8")) !== normalize(output.contents),
  );
  if (stale) {
    throw new Error(`${stale.path} is stale; regenerate it from ${core}`);
  }
  for (const output of outputs) console.log(`${output.path} is current`);
  process.exit(0);
}
for (const output of outputs) {
  mkdirSync(dirname(output.path), { recursive: true });
  writeFileSync(output.path, output.contents);
  console.log(output.path);
}
