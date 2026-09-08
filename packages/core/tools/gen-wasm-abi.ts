import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CORE_WASM_HEADERS } from "../src/wasm/headers";
import { parseWasmAbiSource } from "../src/wasm/abi-source";
import { parseWasmSlotLayoutSource } from "../src/wasm/slot-layout-source";

const args = process.argv.slice(2);
const coreIndex = args.indexOf("--core-dir");
const coreArg = (coreIndex >= 0 ? args[coreIndex + 1] : undefined) ?? process.env.QINIT_CORE;
if (!coreArg) throw new Error("pass --core-dir <core-lite checkout> or set QINIT_CORE");
const core = resolve(coreArg);
const metadataPath = join(core, "src", CORE_WASM_HEADERS.shared.abiMetadata);
const sharedPath = join(core, "src", CORE_WASM_HEADERS.shared.abiTypes);
const metadata = parseWasmAbiSource(readFileSync(metadataPath, "utf8"), readFileSync(sharedPath, "utf8"));
const abiOutput = resolve(import.meta.dir, "..", "src", "wasm", "generated", "wasm-abi.ts");
const generatedAbi =
    "// Generated from core-lite Wasm shared ABI headers. Do not edit.\n" + `export const WASM_ABI_METADATA = ${JSON.stringify(metadata, null, 2)} as const;\n`;
const slotLayout = parseWasmSlotLayoutSource(readFileSync(join(core, "src", "contract_core", "contract_def.h"), "utf8"));
const layoutOutput = resolve(import.meta.dir, "..", "src", "wasm", "generated", "wasm-slot-layout.ts");
const generatedLayout =
    "// Generated from core-lite's standard lite-Wasm contract profile. Do not edit.\n" +
    `export const WASM_SLOT_LAYOUT = ${JSON.stringify(slotLayout, null, 2)} as const;\n`;
const abiArtifact = { path: abiOutput, contents: generatedAbi };
const layoutArtifact = { path: layoutOutput, contents: generatedLayout };
const outputs = [abiArtifact, layoutArtifact];
const normalize = (source: string) => source.replace(/\r\n?/g, "\n");
const isStale = (output: { path: string; contents: string }) =>
    !existsSync(output.path) || normalize(readFileSync(output.path, "utf8")) !== normalize(output.contents);
if (args.includes("--check")) {
    if (isStale(abiArtifact)) {
        throw new Error(`${abiOutput} is stale; regenerate it from ${core}`);
    }
    console.log(`${abiOutput} is current`);
    // The slot base follows the native contract catalog and nodes report theirs over RPC, so a stale default only warns.
    if (isStale(layoutArtifact)) {
        const message = `${layoutOutput} is behind ${core}; regenerate when convenient`;
        console.log(message);
        if (process.env.GITHUB_ACTIONS) console.log(`::warning::${message}`);
    } else {
        console.log(`${layoutOutput} is current`);
    }
    process.exit(0);
}
for (const output of outputs) {
    mkdirSync(dirname(output.path), { recursive: true });
    writeFileSync(output.path, output.contents);
    console.log(output.path);
}
