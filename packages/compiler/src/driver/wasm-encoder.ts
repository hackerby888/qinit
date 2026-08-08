import { WasmModuleMemoryMode } from "../shared/enums";
import type { GeneratedContractMetadata } from "../backend/wasm/module/library-index";
import { inspectWasmModule } from "./wasm-inspect";
import { toWasmFunctionSignatures } from "./wasm-inspection/inspection-types";
import type { CompileOptions } from "./types";

export async function encodeWat(
    wat: string,
    sourceName: string,
): Promise<Uint8Array> {
    const wabt = await import("wabt");
    const wabtModule = await wabt.default();
    const parsedModule = wabtModule.parseWat(sourceName, wat);

    parsedModule.validate();

    return new Uint8Array(parsedModule.toBinary({}).buffer);
}

export async function encodeAndInspectWat(
    wat: string,
    options: CompileOptions,
    metadata: GeneratedContractMetadata,
): Promise<Uint8Array> {
    const wasm = await encodeWat(wat, "contract.wat");

    if (!WebAssembly.validate(wasm)) {
        throw new Error("generated module failed WebAssembly validation");
    }

    const inspection = inspectWasmModule(wasm, {
        memoryMode: options.sharedMemoryBaseOffsetBytes === undefined
            ? WasmModuleMemoryMode.DEFINED
            : WasmModuleMemoryMode.IMPORTED,
        lhostAbi: metadata.lhostAbi
            ? toWasmFunctionSignatures(metadata.lhostAbi)
            : undefined,
    });

    if (!inspection.ok) {
        const message = inspection.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("; ");

        throw new Error(message);
    }

    return wasm;
}

export async function dumpWatIfRequested(wat: string): Promise<void> {
    const process = (globalThis as any).process;
    const outputPath = process?.env?.QINIT_DUMP_WAT;

    if (!outputPath) {
        return;
    }

    const fs = await import("node:fs");
    fs.writeFileSync(outputPath, wat);
}
