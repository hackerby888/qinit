import { Sema } from "../sema";
import {
    generateWasmModule,
    type GeneratedContractMetadata,
} from "../codegen";
import { collectCalleeContext } from "./callees";
import { CompilationPhaseTracker } from "./compilation-phase-tracker";
import {
    parseContractSource,
    preprocessContractSource,
    remapAnalysisDiagnostics,
    validateContractSource,
} from "./contract-frontend";
import { scanUnterminatedSource } from "./diagnostics";
import { extractIdl } from "./idl";
import { validateCompileOpts } from "./options";
import { getQpiContext } from "./qpi-context";
import type { Diagnostic as ParserDiagnostic } from "../parser";
import type { CompileOptions, CompileResult } from "./types";
import { emptyResult } from "./compile-result";
import { dumpWatIfRequested, encodeAndInspectWat } from "./wasm-encoder";

const DEFAULT_ARENA_SIZE = 1024 * 1024 * 1024;

export async function compileContract(
    options: CompileOptions,
): Promise<CompileResult> {
    const diagnostics = collectInitialDiagnostics(options);

    if (diagnostics.length > 0) {
        return emptyResult(options, diagnostics);
    }

    const phases = new CompilationPhaseTracker(options.onPhase);

    await phases.enter("loading qpi.h");
    const qpiContext = loadQpiContext(options);

    await phases.enter("preprocessing");
    const preprocessed = preprocessContractSource(options, qpiContext.macros);

    await phases.enter("parsing");
    const translationUnit = parseContractSource(preprocessed, diagnostics);

    if (hasErrors(diagnostics)) {
        return emptyResult(options, diagnostics);
    }

    await phases.enter("validating");
    validateContractSource(translationUnit, preprocessed, diagnostics);

    if (hasErrors(diagnostics)) {
        return emptyResult(options, diagnostics);
    }

    await phases.enter("analyzing");
    const semanticAnalysis = new Sema();
    const calleeContext = collectCalleeContext(options, qpiContext);
    diagnostics.push(...calleeContext.diagnostics);

    if (hasErrors(diagnostics)) {
        phases.close();
        return emptyResult(options, diagnostics, phases.timings);
    }

    await phases.enter("generating wasm");
    const metadata = createContractMetadata();
    let wat: string;

    try {
        wat = generateContractWat(
            options,
            translationUnit,
            semanticAnalysis,
            qpiContext,
            calleeContext,
            metadata,
        );
    }
    catch (error: any) {
        appendCompilerError(diagnostics, "Codegen failed", error);
        return emptyResult(options, diagnostics);
    }

    diagnostics.push(
        ...remapAnalysisDiagnostics(
            semanticAnalysis.getDiagnostics(),
            preprocessed,
        ),
    );

    await dumpWatIfRequested(wat);
    promoteFidelityDiagnostics(options, diagnostics);

    if (hasErrors(diagnostics)) {
        phases.close();
        return emptyResult(options, diagnostics, phases.timings);
    }

    await phases.enter("assembling wasm");
    let wasm: Uint8Array;

    try {
        wasm = await encodeAndInspectWat(wat, options, metadata);
    }
    catch (error: any) {
        appendCompilerError(diagnostics, "WAT→WASM encode failed", error);
        return emptyResult(options, diagnostics);
    }

    phases.close();

    return {
        wasm,
        diagnostics,
        idl: extractIdl(translationUnit, options, metadata),
        timings: phases.timings,
    };
}

function collectInitialDiagnostics(
    options: CompileOptions,
): ParserDiagnostic[] {
    return [
        ...validateCompileOpts(options),
        ...(typeof options.source === "string"
            ? scanUnterminatedSource(options.source)
            : []),
    ];
}

function loadQpiContext(options: CompileOptions) {
    if (options.qpiHeader === undefined) {
        throw new Error("internal compiler requires a QPI header snapshot");
    }

    return getQpiContext(options.qpiHeader);
}

function generateContractWat(
    options: CompileOptions,
    translationUnit: Parameters<typeof generateWasmModule>[0],
    semanticAnalysis: Sema,
    qpiContext: ReturnType<typeof getQpiContext>,
    calleeContext: ReturnType<typeof collectCalleeContext>,
    metadata: GeneratedContractMetadata,
): string {
    return generateWasmModule(
        translationUnit,
        semanticAnalysis,
        options.name,
        options.slot,
        options.arenaSz ?? DEFAULT_ARENA_SIZE,
        qpiContext.lib,
        options.callees,
        calleeContext.contractStructs,
        calleeContext.calleeTranslationUnits,
        options.sharedMemBase,
        metadata,
    );
}

function createContractMetadata(): GeneratedContractMetadata {
    return {
        stateSize: 0,
        entries: [],
        sysprocMask: 0,
    };
}

function promoteFidelityDiagnostics(
    options: CompileOptions,
    diagnostics: ParserDiagnostic[],
): void {
    if (options.strict === false) {
        return;
    }

    for (const diagnostic of diagnostics) {
        if (diagnostic.category === "fidelity") {
            diagnostic.severity = "error";
        }
    }
}

function hasErrors(diagnostics: ParserDiagnostic[]): boolean {
    return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function appendCompilerError(
    diagnostics: ParserDiagnostic[],
    stage: string,
    error: any,
): void {
    diagnostics.push({
        severity: "error",
        message: `${stage}: ${error.message}`,
        span: {
            start: 0,
            end: 0,
            line: 0,
            column: 0,
        },
    });
}
