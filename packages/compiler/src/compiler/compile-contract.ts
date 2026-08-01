import { DiagnosticCategory, DiagnosticSeverity } from "../enums";
import { SemanticAnalyzer } from "../semantic-analyzer";
import {
    generateWasmModule,
    type ModuleGenerationRequest,
} from "../backend/wasm/module/module-generator";
import type { GeneratedContractMetadata } from "../backend/wasm/module/library-index";
import { collectCalleeContext } from "./callees";
import { CompilationPhaseTracker } from "./compilation-phase-tracker";
import {
    parseContractSource,
    preprocessContractSource,
    remapAnalysisDiagnostics,
    validateContractSource,
} from "./contract-frontend";
import { scanUnterminatedSource } from "./diagnostics";
import { validateCompileOptions } from "./options";
import { getQpiContext } from "./qpi-context";
import type { Diagnostic as ParserDiagnostic } from "../parser";
import type { CompileOptions, CompileResult } from "./types";
import { emptyResult } from "./compile-result";
import { dumpWatIfRequested, encodeAndInspectWat } from "./wasm-encoder";
import { collectSourceContractCalls } from "./semantic-calls";
import { DEFAULT_COMPILE_ARENA_SIZE_BYTES } from "../defaults";

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
    const semanticAnalysis = new SemanticAnalyzer();
    const calleeContext = collectCalleeContext(options, qpiContext);
    diagnostics.push(...calleeContext.diagnostics);

    if (hasErrors(diagnostics)) {
        phases.close();
        return emptyResult(options, diagnostics, phases.timings);
    }

    await phases.enter("generating wasm");
    const calls = collectSourceContractCalls(
        options.source,
        options.contractName,
        options.slot,
        qpiContext.macros,
    );
    const metadata = createContractMetadata(
        calls.map((call) => call.callee),
    );
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
        idl: metadata.idl,
        timings: phases.timings,
    };
}

function collectInitialDiagnostics(
    options: CompileOptions,
): ParserDiagnostic[] {
    return [
        ...validateCompileOptions(options),
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
    translationUnit: ModuleGenerationRequest["translationUnit"],
    semanticAnalysis: SemanticAnalyzer,
    qpiContext: ReturnType<typeof getQpiContext>,
    calleeContext: ReturnType<typeof collectCalleeContext>,
    metadata: GeneratedContractMetadata,
): string {
    return generateWasmModule({
        translationUnit,
        semanticAnalysis,
        contractName: options.contractName,
        contractSlot: options.slot,
        arenaSize: options.arenaSizeBytes ?? DEFAULT_COMPILE_ARENA_SIZE_BYTES,
        libraryIndex: qpiContext.lib,
        callees: options.callees,
        calleeStructs: calleeContext.contractStructs,
        calleeTranslationUnits: calleeContext.calleeTranslationUnits,
        sharedMemoryBase: options.sharedMemoryBaseOffsetBytes,
        metadataOutput: metadata,
        gtestMode: false,
    });
}

function createContractMetadata(
    dependencies: string[],
): GeneratedContractMetadata {
    return {
        stateSize: 0,
        entries: [],
        sysprocMask: 0,
        dependencies: [...new Set(dependencies)],
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
        if (diagnostic.category === DiagnosticCategory.FIDELITY) {
            diagnostic.severity = DiagnosticSeverity.ERROR;
        }
    }
}

function hasErrors(diagnostics: ParserDiagnostic[]): boolean {
    return diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
}

function appendCompilerError(
    diagnostics: ParserDiagnostic[],
    stage: string,
    error: any,
): void {
    diagnostics.push({
        severity: DiagnosticSeverity.ERROR,
        message: `${stage}: ${error.message}`,
        span: {
            start: 0,
            end: 0,
            line: 0,
            column: 0,
        },
    });
}
