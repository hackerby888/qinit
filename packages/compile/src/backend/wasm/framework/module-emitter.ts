import { resetLhostCallSigs } from "../../../wat-ir";
import type { FrameworkOptions, ModuleSpecification } from "./framework-types";
import { computeLayout } from "./framework-types";
import { emitExportList, emitGlobals, emitImports } from "./imports-and-globals";
import { emitAllocators, emitMemOps } from "./memory-runtime";
import { emitForwarders } from "./forwarders";
import { emitIntrinsics } from "./intrinsics";
import { emitMetadata } from "./metadata";
import { emitDispatch, emitInitialize } from "./dispatch";

// ---- The complete module assembler ----
export function emitModule(spec: ModuleSpecification): string {
    resetLhostCallSigs();
    const usesPrng = spec.capabilities?.includes("chain-prng") ?? false;
    const capacity = computeLayout(spec.stateSize, spec.arenaSize, spec.contextLayout.size, spec.memBase ?? (usesPrng ? 8 : 0), spec.assetEnumerationRecord);
    const sysprocMask = spec.sysprocs.reduce((sysproc, sp) => sysproc | (1 << sp.id), 0);
    return [
        "(module",
        "  ;; ---- qinit-compile generated module ----",
        emitImports(spec.gtest, spec.lhostAbi),
        spec.memBase !== undefined
            ? `  (import "env" "memory" (memory ${capacity.pages}))`
            : `  (memory (export "memory") ${capacity.pages} ${capacity.pages})`,
        emitGlobals(capacity),
        emitExportList(),
        emitMemOps(),
        emitAllocators(capacity),
        emitForwarders(spec.contextLayout),
        emitIntrinsics(capacity, spec),
        emitMetadata(capacity, spec, sysprocMask),
        spec.userFunctionsWat,
        emitDispatch(spec, usesPrng),
        emitInitialize(),
        ")",
    ].join("\n");
}

// Back-compat wrapper (string-only, no user functions) used by the spike test.
export function emitFramework(options: FrameworkOptions): string {
    return emitModule({
        stateSize: options.stateSize,
        arenaSize: options.arenaSize,
        contextLayout: options.contextLayout,
        entries: [],
        sysprocs: [],
        userFunctionsWat: "  ;; ---- USER CODE (spliced by codegen.ts) ----",
    });
}
