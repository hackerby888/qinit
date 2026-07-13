import { Lexer } from "../lexer";
import { Parser, type Diagnostic as ParserDiagnostic } from "../parser";
import { Preprocessor } from "../preprocess";
import { Sema } from "../sema";
import { validateAndDesugar } from "../validate";
import { generateWasmModule, type GeneratedContractMetadata } from "../codegen";
import { SCAFFOLD_MACROS } from "../qpi-scaffold";
import { collectCalleeContext } from "./callees";
import { makeUserDiagnosticRemapper, scanUnterminatedSource, sourceWithoutLeadingBom, USER_BOUNDARY } from "./diagnostics";
import { extractIdl } from "./idl";
import { validateCompileOpts } from "./options";
import { getQpiContext } from "./qpi-context";
import { inspectLiteWasmModule } from "./wasm-inspect";
import type { CompileOptions, CompileResult } from "./types";
import { emptyResult } from "./compile-result";

export async function compileContract(options: CompileOptions): Promise<CompileResult> {
    const diagnostics: ParserDiagnostic[] = [
        ...validateCompileOpts(options),
        ...(typeof options.source === "string" ? scanUnterminatedSource(options.source) : []),
    ];
    if (diagnostics.length > 0)
        return emptyResult(options, diagnostics);
    const timings: Record<string, number> = {};
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    let lastName = "";
    let lastStart = now();
    const phase = async (name: string): Promise<void> => {
        const time = now();
        if (lastName)
            timings[lastName] = time - lastStart;
        if (options.onPhase) {
            await options.onPhase(name);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        lastName = name;
        lastStart = now();
    };
    const closePhase = () => {
        if (lastName)
            timings[lastName] = now() - lastStart;
        lastName = "";
    };
    await phase("loading qpi.h");
    if (options.qpiHeader === undefined)
        throw new Error("internal compiler requires a QPI header snapshot");
    const qpi = getQpiContext(options.qpiHeader);
    await phase("preprocessing");
    const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(options.source)}`;
    const preprocessedSource = new Preprocessor().preprocess({
        source,
        qpiHeader: "",
        contractName: options.name,
        contractIndex: options.slot,
        seedMacros: qpi.macros,
    });
    const boundaryIndex = preprocessedSource.indexOf(USER_BOUNDARY);
    const boundaryLine = boundaryIndex >= 0 ? preprocessedSource.slice(0, boundaryIndex).split("\n").length : 0;
    const remap = makeUserDiagnosticRemapper(options.source, preprocessedSource, boundaryLine);
    await phase("parsing");
    const parser = new Parser(new Lexer(preprocessedSource).tokenize());
    const unit = parser.parseTranslationUnit();
    diagnostics.push(...parser
        .getDiagnostics()
        .filter((diagnostic) => diagnostic.span.line > boundaryLine)
        .map(remap));
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
        return emptyResult(options, diagnostics);
    await phase("validating");
    diagnostics.push(...validateAndDesugar(unit)
        .filter((diagnostic) => diagnostic.span.line > boundaryLine)
        .map(remap));
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
        return emptyResult(options, diagnostics);
    await phase("analyzing");
    const sema = new Sema();
    const calleeContext = collectCalleeContext(options, qpi);
    diagnostics.push(...calleeContext.diagnostics);
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        closePhase();
        return emptyResult(options, diagnostics, timings);
    }
    await phase("generating wasm");
    let wat: string;
    const metadata: GeneratedContractMetadata = { stateSize: 0, entries: [], sysprocMask: 0 };
    try {
        wat = generateWasmModule(unit, sema, options.name, options.slot, options.arenaSz ?? 1024 * 1024 * 1024, qpi.lib, options.callees, calleeContext.contractStructs, calleeContext.calleeTranslationUnits, options.sharedMemBase, metadata);
    }
    catch (error: any) {
        diagnostics.push({
            severity: "error",
            message: `Codegen failed: ${error.message}`,
            span: { start: 0, end: 0, line: 0, column: 0 },
        });
        return emptyResult(options, diagnostics);
    }
    diagnostics.push(...sema
        .getDiagnostics()
        .map((diagnostic) => (diagnostic.span.line > boundaryLine ? remap(diagnostic) : diagnostic)));
    if ((globalThis as any).process?.env?.QINIT_DUMP_WAT) {
        const fs = await import("node:fs");
        fs.writeFileSync((globalThis as any).process.env.QINIT_DUMP_WAT, wat);
    }
    if (options.strict !== false) {
        for (const diagnostic of diagnostics)
            if (diagnostic.category === "fidelity")
                diagnostic.severity = "error";
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        closePhase();
        return emptyResult(options, diagnostics, timings);
    }
    await phase("assembling wasm");
    let wasm: Uint8Array;
    try {
        const wabt = await import("wabt");
        const module = await wabt.default();
        const parsed = module.parseWat("contract.wat", wat);
        parsed.validate();
        wasm = new Uint8Array(parsed.toBinary({}).buffer);
        if (!WebAssembly.validate(wasm)) {
            throw new Error("generated module failed WebAssembly validation");
        }
        const inspection = inspectLiteWasmModule(wasm, {
            memoryMode: options.sharedMemBase === undefined ? "defined" : "imported",
            lhostAbi: metadata.lhostAbi,
        });
        if (!inspection.ok) {
            throw new Error(inspection.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
        }
    }
    catch (error: any) {
        diagnostics.push({
            severity: "error",
            message: `WAT→WASM encode failed: ${error.message}`,
            span: { start: 0, end: 0, line: 0, column: 0 },
        });
        return emptyResult(options, diagnostics);
    }
    closePhase();
    return { wasm, diagnostics, idl: extractIdl(unit, options, metadata), timings };
}
