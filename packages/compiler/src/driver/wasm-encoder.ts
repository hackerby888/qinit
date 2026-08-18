import { instrumentStateJournal } from "@qinit/core/wasm/instrument";
import { WasmModuleMemoryMode } from "../shared/enums";
import type { GeneratedContractMetadata } from "../backend/wasm/module/library-index";
import { inspectWasmModule } from "./wasm-inspection";
import { toWasmFunctionSignatures } from "./wasm-inspection/inspection-types";
import type { CompileOptions } from "./types";

// ArrayBuffer-backed, not just `Uint8Array`: the browser's DOM lib types `BufferSource` as
// ArrayBuffer-only, so a possibly-shared view is not a valid `WebAssembly.validate` argument.
export async function encodeWat(wat: string, sourceName: string): Promise<Uint8Array<ArrayBuffer>> {
    const wabt = await import("wabt");
    const wabtModule = await wabt.default();
    const parsedModule = wabtModule.parseWat(sourceName, wat);

    parsedModule.validate();

    return new Uint8Array(parsedModule.toBinary({}).buffer);
}

/** `QINIT_NO_STATE_JOURNAL=1` builds without the journal, so a pristine module is available to compare against. */
export function stateJournalDisabled(): boolean {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.QINIT_NO_STATE_JOURNAL === "1";
}

export async function encodeAndInspectWat(wat: string, options: CompileOptions, metadata: GeneratedContractMetadata): Promise<Uint8Array> {
    const encoded = await encodeWat(wat, "contract.wat");

    // Baked in before inspection, so the module that ships is the one the ABI gate checked. Shared
    // memory reserves no journal room, so it is skipped.
    const bakeJournal = options.sharedMemoryBaseOffsetBytes === undefined && !stateJournalDisabled();
    const journalOptions = options.journalCapBytes === undefined ? {} : { journalCapBytes: options.journalCapBytes };
    const wasm = bakeJournal ? instrumentStateJournal(encoded, journalOptions).wasm : encoded;

    if (!WebAssembly.validate(wasm)) {
        throw new Error("generated module failed WebAssembly validation");
    }

    const inspection = inspectWasmModule(wasm, {
        memoryMode: options.sharedMemoryBaseOffsetBytes === undefined ? WasmModuleMemoryMode.DEFINED : WasmModuleMemoryMode.IMPORTED,
        lhostAbi: metadata.lhostAbi ? toWasmFunctionSignatures(metadata.lhostAbi) : undefined,
    });

    if (!inspection.ok) {
        const message = inspection.diagnostics.map((diagnostic) => diagnostic.message).join("; ");

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
