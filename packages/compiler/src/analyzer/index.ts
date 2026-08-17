import type { Span } from "../ast";
import type { ContractIdl } from "@qinit/proto/contract-idl";
import type { ParserDiagnostic } from "../frontend/parser";
import { AnalysisPhase, DiagnosticCategory, DiagnosticSeverity, MemberCompletionKind, QpiContextKind, SourceAnalysisOrigin } from "../shared/enums";
import { QPI_SNAPSHOT } from "../generated/qpi-snapshot";
import { parseContractSource, preprocessContractSource, remapAnalysisDiagnostics, validateAndDesugarContractSource } from "../driver/contract-frontend";
import { scanUnterminatedSource } from "../driver/diagnostics";
import { getQpiMacros } from "../driver/qpi-macros";
import type { CompileOptions } from "../driver/types";
import { collectCalleeContext } from "../driver/callees";
import { collectProcedureDeclLines, collectSourceContractCalls, type SourceContractCall } from "../driver/semantic-calls";
import { getQpiContext } from "../driver/qpi-context";
import { SemanticAnalyzer } from "../semantics/semantic-analysis";
import { prepareContractModule } from "../backend/wasm/module/module-analysis";
import type { ContractRegistration } from "../backend/wasm/module/registrations";
import { copyProgramDiagnostics } from "../backend/wasm/module/module-output";
import { buildContractIdl } from "../backend/wasm/idl";
import { analyzeQpiPolicy, detectQpiContractName } from "./source-policy";
import { compareDiagnostics } from "./rules/fixes";

export { QPI_BANNED_KEYWORDS } from "./source-policy";
export { completeMembersAt, completeMembersOfType, declaredTypeOf, splitReceiver } from "./member-query";
export type { MemberCompletion, MemberQueryOptions, TypeMemberQueryOptions } from "./member-query";
export { Lexer, TokenKind } from "../frontend/lexer";
export type { Token } from "../frontend/lexer";
export { AnalysisPhase, DiagnosticCategory, DiagnosticSeverity, MemberCompletionKind, QpiContextKind, SourceAnalysisOrigin };
export type { SourceContractCall };

export interface AnalyzeContractOptions {
    source: string;
    contractName?: string;
    slot?: number;
    qpiHeader?: string;
    callees?: ContractIdl[];
    calleeSources?: Array<{
        name: string;
        source: string;
        slot?: number;
    }>;
}

export interface SourceEdit {
    span: Span;
    newText: string;
}

export interface SourceFix {
    title: string;
    preferred?: boolean;
    edits: SourceEdit[];
}

export interface SourceAnalysisDiagnostic {
    origin: SourceAnalysisOrigin;
    code: string;
    severity: DiagnosticSeverity.ERROR | DiagnosticSeverity.WARNING | DiagnosticSeverity.INFORMATION;
    message: string;
    span: Span;
    fixes?: SourceFix[];
}

export interface SourceAnalysisResult {
    diagnostics: SourceAnalysisDiagnostic[];
    calls: SourceContractCall[];
    idl?: ContractIdl;
}

export function analyzeContract(options: AnalyzeContractOptions): SourceAnalysisResult {
    const normalizedOptions = {
        ...options,
        qpiHeader: options.qpiHeader ?? QPI_SNAPSHOT,
        contractName: options.contractName ?? detectQpiContractName(options.source) ?? "Contract",
        slot: options.slot ?? 0,
    };
    const calls = collectSourceContractCalls(
        normalizedOptions.source,
        normalizedOptions.contractName,
        normalizedOptions.slot,
        getQpiMacros(normalizedOptions.qpiHeader),
    );
    const compilerResult = analyzeCompiler(normalizedOptions, calls);
    const diagnostics = compilerResult.diagnostics;

    try {
        diagnostics.push(...analyzeQpiPolicy(options.source, compilerResult.registrations, compilerResult.idl));
    } catch (error: any) {
        diagnostics.push(internalDiagnostic(error));
    }

    const seen = new Set<string>();
    return {
        calls,
        idl: compilerResult.idl,
        diagnostics: diagnostics
            .filter((item) => {
                const key = [item.origin, item.code, item.span.start, item.span.end, item.message].join(":");
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            })
            .sort(compareDiagnostics),
    };
}

export function detectContractName(source: string): string | undefined {
    return detectQpiContractName(source);
}

function analyzeCompiler(
    options: AnalyzeContractOptions & {
        contractName: string;
        slot: number;
        qpiHeader: string;
    },
    calls: SourceContractCall[],
): {
    diagnostics: SourceAnalysisDiagnostic[];
    idl?: ContractIdl;
    registrations?: ContractRegistration[];
} {
    const earlyDiagnostics = scanUnterminatedSource(options.source);
    if (hasErrors(earlyDiagnostics)) {
        return {
            diagnostics: earlyDiagnostics.map((item) => compilerDiagnostic(item, AnalysisPhase.SYNTAX)),
        };
    }

    try {
        const compileOptions: CompileOptions = {
            source: options.source,
            contractName: options.contractName,
            slot: options.slot,
            qpiHeader: options.qpiHeader,
            callees: options.callees,
            calleeSources: options.calleeSources,
        };
        const qpiContext = getQpiContext(options.qpiHeader);
        const preprocessed = preprocessContractSource(compileOptions, getQpiMacros(options.qpiHeader));
        const parserDiagnostics: ParserDiagnostic[] = [];
        const translationUnit = parseContractSource(preprocessed, parserDiagnostics);
        const diagnostics = parserDiagnostics.map((item) => compilerDiagnostic(item, AnalysisPhase.SYNTAX));

        if (hasErrors(parserDiagnostics)) {
            return { diagnostics };
        }

        const validationDiagnostics: ParserDiagnostic[] = [];
        validateAndDesugarContractSource(translationUnit, preprocessed, validationDiagnostics);
        diagnostics.push(...validationDiagnostics.map((item) => compilerDiagnostic(item, AnalysisPhase.SEMANTIC)));

        if (hasErrors(validationDiagnostics)) {
            return { diagnostics };
        }

        const semanticAnalysis = new SemanticAnalyzer();
        const calleeContext = collectCalleeContext(compileOptions, qpiContext);
        diagnostics.push(...calleeContext.diagnostics.map((item) => compilerDiagnostic(item, AnalysisPhase.SYNTAX)));

        if (hasErrors(calleeContext.diagnostics)) {
            return { diagnostics };
        }

        const prepared = prepareContractModule({
            translationUnit,
            semanticAnalysis,
            contractSlot: compileOptions.slot,
            procedureDeclLines: collectProcedureDeclLines(compileOptions.source),
            libraryIndex: qpiContext.lib,
            callees: compileOptions.callees,
            calleeStructs: calleeContext.contractStructs,
            calleeTranslationUnits: calleeContext.calleeTranslationUnits,
            gtestMode: false,
        });
        const idl = buildContractIdl(prepared, {
            contractName: compileOptions.contractName,
            slot: compileOptions.slot,
            dependencies: calls.map((call) => call.callee),
        });
        copyProgramDiagnostics(prepared.programAnalysis, semanticAnalysis);
        diagnostics.push(
            ...remapAnalysisDiagnostics(semanticAnalysis.getDiagnostics(), preprocessed).map((item) => compilerDiagnostic(item, AnalysisPhase.SEMANTIC)),
        );

        if (diagnostics.some((item) => item.severity === DiagnosticSeverity.ERROR)) {
            return {
                diagnostics,
                registrations: prepared.registrations,
            };
        }

        return {
            diagnostics,
            idl,
            registrations: prepared.registrations,
        };
    } catch (error: any) {
        return {
            diagnostics: [internalDiagnostic(error)],
        };
    }
}

function compilerDiagnostic(item: ParserDiagnostic, phase: AnalysisPhase): SourceAnalysisDiagnostic {
    return {
        origin: SourceAnalysisOrigin.COMPILER,
        code: item.category === DiagnosticCategory.FIDELITY ? "compiler/fidelity" : `compiler/${phase}`,
        severity: item.severity,
        message: item.message,
        span: item.span,
    };
}

function internalDiagnostic(error: any): SourceAnalysisDiagnostic {
    return {
        origin: SourceAnalysisOrigin.COMPILER,
        code: "compiler/internal",
        severity: DiagnosticSeverity.ERROR,
        message: `Source analysis failed: ${String(error?.message ?? error)}`,
        span: {
            start: 0,
            end: 0,
            line: 1,
            column: 1,
        },
    };
}

function hasErrors(diagnostics: ParserDiagnostic[]): boolean {
    return diagnostics.some((item) => item.severity === DiagnosticSeverity.ERROR);
}
