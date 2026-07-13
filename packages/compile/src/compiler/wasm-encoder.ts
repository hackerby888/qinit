import type { GeneratedContractMetadata } from "../codegen";
import { inspectLiteWasmModule } from "./wasm-inspect";
import type { CompileOptions } from "./types";

export async function encodeAndInspectWat(
    wat: string,
    options: CompileOptions,
    metadata: GeneratedContractMetadata,
): Promise<Uint8Array> {
    const wabt = await import("wabt");
    const wabtModule = await wabt.default();
    const parsedModule = wabtModule.parseWat("contract.wat", wat);

    parsedModule.validate();

    const wasm = new Uint8Array(parsedModule.toBinary({}).buffer);

    if (!WebAssembly.validate(wasm)) {
        throw new Error("generated module failed WebAssembly validation");
    }

    const inspection = inspectLiteWasmModule(wasm, {
        memoryMode: options.sharedMemBase === undefined ? "defined" : "imported",
        lhostAbi: metadata.lhostAbi,
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
