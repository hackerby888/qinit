import * as vscode from "vscode";
import type { ProjectSourceDetails } from "./project-context";
import {
    analyzeContract,
    DiagnosticSeverity,
    SourceAnalysisOrigin,
    type SourceAnalysisDiagnostic,
    type SourceAnalysisResult,
    type SourceFix,
} from "@qinit/compiler/analyzer";
import type { ProjectAnalysisContext } from "./project-context";
import { configuredContractIdentity, isContractDoc } from "./project-util";

const SEVERITY: Record<SourceAnalysisDiagnostic["severity"], vscode.DiagnosticSeverity> = {
    [DiagnosticSeverity.ERROR]: vscode.DiagnosticSeverity.Error,
    [DiagnosticSeverity.WARNING]: vscode.DiagnosticSeverity.Warning,
    [DiagnosticSeverity.INFORMATION]: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(doc: vscode.TextDocument, item: SourceAnalysisDiagnostic): vscode.Diagnostic {
    const range = new vscode.Range(doc.positionAt(item.span.start), doc.positionAt(item.span.end));
    const diagnostic = new vscode.Diagnostic(range, item.message, SEVERITY[item.severity]);
    diagnostic.source = item.origin === SourceAnalysisOrigin.QPI ? "qpi" : "qinit-compiler";
    diagnostic.code = item.code;
    return diagnostic;
}

/** What the extension hands back for a document: its analysis context, and why it lost one if it did. */
export type ResolvedContext = Pick<ProjectSourceDetails, "unresolved"> & {
    analysis: ProjectAnalysisContext;
    /** Callees missing from this file's prelude: every reference to one will read as undeclared. */
    droppedCallees?: ReadonlyArray<{ type: string; reason: string }>;
};

export class QpiDiagnostics implements vscode.Disposable {
    private readonly coll = vscode.languages.createDiagnosticCollection("qpi");
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly analyses = new Map<
        string,
        {
            version: number;
            name?: string;
            slot?: number;
            contextKey?: string;
            result: SourceAnalysisResult;
        }
    >();
    private readonly contextErrors = new Map<string, { version: number; message: string }>();
    // A contract the project could not keep in its plan: analysis still succeeds, standalone, so this
    // rides alongside the ordinary diagnostics rather than replacing them.
    private readonly unresolvedContracts = new Map<string, { version: number; name: string; reason: string }>();
    private readonly droppedCallees = new Map<string, { version: number; items: ReadonlyArray<{ type: string; reason: string }> }>();
    private readonly fixes = new Map<
        string,
        {
            version: number;
            items: Map<string, SourceFix[]>;
        }
    >();

    constructor(private readonly resolveContext?: (doc: vscode.TextDocument) => ResolvedContext) {}

    private applies(doc: vscode.TextDocument): boolean {
        return isContractDoc(doc);
    }

    schedule(doc: vscode.TextDocument, delay = 250): void {
        if (doc.uri.scheme !== "file" || !/\.(h|hpp|hxx)$/i.test(doc.fileName)) {
            return;
        }

        const key = doc.uri.toString();
        const prev = this.timers.get(key);
        if (prev) {
            clearTimeout(prev);
        }

        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                this.refresh(doc);
            }, delay),
        );
    }

    analysisFor(doc: vscode.TextDocument): SourceAnalysisResult | undefined {
        const key = doc.uri.toString();
        if (!this.applies(doc)) {
            this.analyses.delete(key);
            this.contextErrors.delete(key);
            return undefined;
        }

        const identity = configuredContractIdentity(doc.fileName);
        let context: ProjectAnalysisContext | undefined;
        try {
            const resolved = this.resolveContext?.(doc);
            context = resolved?.analysis;
            this.contextErrors.delete(key);
            this.unresolvedContracts.delete(key);
            this.droppedCallees.delete(key);
            if (resolved?.unresolved) {
                this.unresolvedContracts.set(key, { version: doc.version, ...resolved.unresolved });
            }
            if (resolved?.droppedCallees?.length) {
                this.droppedCallees.set(key, { version: doc.version, items: resolved.droppedCallees });
            }
        } catch (error: any) {
            this.analyses.delete(key);
            this.fixes.delete(key);
            this.unresolvedContracts.delete(key);
            this.droppedCallees.delete(key);
            this.contextErrors.set(key, {
                version: doc.version,
                message: String(error?.message ?? error),
            });
            return undefined;
        }

        const cached = this.analyses.get(key);
        if (
            cached?.version === doc.version &&
            cached.name === (context?.contractName ?? identity.name) &&
            cached.slot === (context?.slot ?? identity.slot) &&
            cached.contextKey === context?.cacheKey
        ) {
            return cached.result;
        }
        const result = analyzeContract({
            source: doc.getText(),
            contractName: context?.contractName ?? identity.name,
            slot: context?.slot ?? identity.slot,
            qpiHeader: context?.qpiHeader,
            callees: context?.callees,
            calleeSources: context?.calleeSources,
        });
        this.fixes.delete(key);
        this.analyses.set(key, {
            version: doc.version,
            name: context?.contractName ?? identity.name,
            slot: context?.slot ?? identity.slot,
            contextKey: context?.cacheKey,
            result,
        });
        return result;
    }

    refresh(doc: vscode.TextDocument): void {
        const result = this.analysisFor(doc);
        if (!result) {
            const contextError = this.contextErrors.get(doc.uri.toString());
            if (contextError?.version === doc.version) {
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, Math.min(1, doc.lineAt(0).text.length)),
                    `Project dependency resolution failed: ${contextError.message}`,
                    vscode.DiagnosticSeverity.Error,
                );
                diagnostic.source = "qinit-project";
                diagnostic.code = "qinit/project-dependencies";
                this.coll.set(doc.uri, [diagnostic]);
                return;
            }
            this.clear(doc.uri);
            return;
        }

        const unresolved = this.unresolvedContracts.get(doc.uri.toString());
        const extra: vscode.Diagnostic[] = [];
        if (unresolved?.version === doc.version) {
            const diagnostic = new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, Math.min(1, doc.lineAt(0).text.length)),
                `'${unresolved.name}' could not be resolved as part of this project, so its callees are unavailable here and ` +
                    `references to them will not resolve: ${unresolved.reason}`,
                vscode.DiagnosticSeverity.Warning,
            );
            diagnostic.source = "qinit-project";
            diagnostic.code = "qinit/project-dependencies";
            extra.push(diagnostic);
        }

        const dropped = this.droppedCallees.get(doc.uri.toString());
        if (dropped?.version === doc.version) {
            for (const callee of dropped.items) {
                const diagnostic = new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, Math.min(1, doc.lineAt(0).text.length)),
                    `'${callee.type}' could not be analysed, so it is missing from this contract's callee prelude and every ` +
                        `'${callee.type}::' reference will read as an undeclared identifier: ${callee.reason}`,
                    vscode.DiagnosticSeverity.Warning,
                );
                diagnostic.source = "qinit-project";
                diagnostic.code = "qinit/callee-dropped";
                extra.push(diagnostic);
            }
        }

        const fixes = new Map<string, SourceFix[]>();
        const diagnostics = result.diagnostics.map((item) => {
            const value = toDiagnostic(doc, item);
            if (item.fixes?.length) {
                fixes.set(diagnosticKey(value), item.fixes);
            }
            return value;
        });

        this.fixes.set(doc.uri.toString(), {
            version: doc.version,
            items: fixes,
        });
        this.coll.set(doc.uri, [...extra, ...diagnostics]);
    }

    fixesFor(doc: vscode.TextDocument, diagnostic: vscode.Diagnostic): SourceFix[] {
        const cached = this.fixes.get(doc.uri.toString());
        if (!cached || cached.version !== doc.version) {
            return [];
        }
        return cached.items.get(diagnosticKey(diagnostic)) ?? [];
    }

    clear(uri: vscode.Uri): void {
        const key = uri.toString();
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
        }

        this.timers.delete(key);
        this.analyses.delete(key);
        this.contextErrors.delete(key);
        this.coll.delete(uri);
        this.fixes.delete(key);
    }

    dispose(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        this.analyses.clear();
        this.contextErrors.clear();
        this.unresolvedContracts.clear();
        this.droppedCallees.clear();
        this.fixes.clear();
        this.coll.dispose();
    }
}

function diagnosticKey(diagnostic: vscode.Diagnostic): string {
    const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
    return [
        code,
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.range.end.line,
        diagnostic.range.end.character,
        diagnostic.message,
    ].join(":");
}
