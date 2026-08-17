import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as vscode from "vscode";
import { loadConfig } from "@qinit/core/project";
import { QpiCodeActions } from "./codeactions";
import { generateClangdConfig, generateTestClangdConfig } from "./clangd-config";
import { completionScope, documentIdentifiers, keepCompletionLabel, keepMemberLabel, keepQualifiedScope, qpiAllowedIdentifiers } from "./completion-filter";
import { QpiDiagnostics } from "./diagnostics";
import { IdlHover } from "./idl-hover";
import { memberFallbackCompletions, type FallbackItem } from "./member-fallback";
import { type ProjectAnalysisContext, type ProjectSourceDetails, resolveProjectSourceDetails } from "./project-context";
import { findContractCandidates, findProjectRoot, isContractDoc, isTestDoc, projectContractDocuments, QINIT_JSON, selectTestContract } from "./project-util";

const warned = new Set<string>();
const restartingRoots = new Set<string>();
const pendingRefreshRoots = new Set<string>();
const filteredClients = new WeakSet<object>();
// The prefix header clangd is using for the active contract: the root of the allowed-identifier walk.
let contractPrefixPath: string | undefined;
let contractCorePath: string | undefined;
let filterReported = false;
let fallbackReported = false;
// Keyed per document: a contract analyzes under its own name, slot and callees, not the last-regenerated one.
const contractAnalysisContexts = new Map<string, ProjectAnalysisContext>();

function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    vscode.window.showWarningMessage(message);
}

function workspaceRoot(doc: vscode.TextDocument): string {
    return vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? findProjectRoot(doc.fileName) ?? dirname(doc.fileName);
}

function dataRoot(context: vscode.ExtensionContext, root: string): string {
    const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
    const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
    return join(storage, key);
}

function bundledCore(context: vscode.ExtensionContext): string | undefined {
    const core = context.asAbsolutePath(join("resources", "core-headers"));
    const qpi = join(core, "src", "qpi", "qpi.h");
    const sysroot = join(core, "wasi-sdk", "share", "wasi-sysroot");
    return existsSync(qpi) && existsSync(sysroot) ? core : undefined;
}

function reportClangdConfig(configured: boolean, configPath: string, databaseDir: string): void {
    if (configured) return;
    warnOnce(`clangd:${configPath}`, `Qubic QPI: ${configPath} is user-owned. Point its CompilationDatabase to ${databaseDir}.`);
}

type CompletionResult = vscode.CompletionItem[] | vscode.CompletionList | null | undefined;

function labelOf(item: vscode.CompletionItem): string {
    return typeof item.label === "string" ? item.label : item.label.label;
}

function memberSnippet(item: FallbackItem): vscode.SnippetString {
    const snippet = new vscode.SnippetString(`${item.name}(`);
    item.placeholders.forEach((placeholder, index) => {
        if (index > 0) snippet.appendText(", ");
        snippet.appendPlaceholder(placeholder);
    });
    snippet.appendText(")");
    return snippet;
}

// Only `label.detail` renders inline, directly after the name — `label.description` sits far right and
// `CompletionItem.detail` only reaches the details pane. So a field annotates its type there, the way a
// method already shows its parameters, and both also fill the details pane.
function fallbackCompletionItem(item: FallbackItem): vscode.CompletionItem {
    if (item.kind !== "method") {
        const field = new vscode.CompletionItem(
            { label: item.name, detail: item.returnType && `: ${item.returnType}` },
            vscode.CompletionItemKind.Field,
        );
        field.detail = item.returnType;
        field.filterText = item.name;
        return field;
    }

    const method = new vscode.CompletionItem(
        {
            label: item.name,
            detail: `(${item.placeholders.join(", ")})`,
            description: item.returnType,
        },
        vscode.CompletionItemKind.Method,
    );
    method.filterText = item.name;
    method.detail = item.returnType;
    method.insertText = memberSnippet(item);
    if (item.placeholders.length > 0) {
        method.command = {
            command: "editor.action.triggerParameterHints",
            title: "Parameter hints",
        };
    }
    return method;
}

const TYPED_WORD = /[A-Za-z0-9_]*$/;
const HOVER_TYPE = /^Type:\s*(.+)$/m;

// clangd prints a variable's type on its own hover line, and resolves it correctly even where the
// completion bug leaves the member list empty — so that line is the seam for a general-C++ receiver.
async function hoverTypeAt(doc: vscode.TextDocument, offset: number): Promise<string | undefined> {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, doc.positionAt(offset));
    for (const hover of hovers ?? []) {
        for (const content of hover.contents) {
            const declared = HOVER_TYPE.exec(typeof content === "string" ? content : content.value)?.[1];
            if (declared) return declared.replace(/`/g, "").trim();
        }
    }
    return undefined;
}

// clangd's member completion breaks on preamble types with template members (member-fallback.ts),
// so an empty list is retried through the QPI compiler, which resolves the same types.
async function fallbackMemberCompletions(
    doc: vscode.TextDocument,
    position: vscode.Position,
    linePrefix: string,
    token: vscode.CancellationToken,
    out: vscode.OutputChannel,
): Promise<vscode.CompletionItem[]> {
    // Completing at the member operator returns the whole list and leaves matching to the editor.
    const typed = TYPED_WORD.exec(linePrefix)?.[0] ?? "";
    const items = await memberFallbackCompletions({
        bufferText: doc.getText(),
        line: position.line,
        character: position.character - typed.length,
        context: contractAnalysisContexts.get(doc.fileName),
        cancel: token,
        rootType: (offset) => hoverTypeAt(doc, offset),
    });
    if (!items) return [];
    if (!fallbackReported) {
        fallbackReported = true;
        out.appendLine(`member completion answered by the QPI compiler: ${items.length} items`);
    }
    return items.filter((item) => keepMemberLabel(item.name)).map(fallbackCompletionItem);
}

// A member list is already scoped by its type, so only the names QPI reserves have to go — and when
// Sema resolved nothing (an empty list, or one padded with word-list items) the compiler answers.
async function memberCompletions(
    doc: vscode.TextDocument,
    position: vscode.Position,
    linePrefix: string,
    items: readonly vscode.CompletionItem[],
    token: vscode.CancellationToken,
    out: vscode.OutputChannel,
): Promise<vscode.CompletionItem[]> {
    const kept = items.filter((item) => keepMemberLabel(labelOf(item)));
    const unresolved = items.length === 0 || items.every((item) => item.kind === undefined || item.kind === vscode.CompletionItemKind.Text);
    if (!unresolved) return kept;

    const fallback = await fallbackMemberCompletions(doc, position, linePrefix, token, out);
    return fallback.length > 0 ? fallback : kept;
}

// clangd offers every symbol the translation unit can see; a contract may write only the QPI surface.
async function filterCompletions(
    doc: vscode.TextDocument,
    position: vscode.Position,
    result: CompletionResult,
    core: string,
    token: vscode.CancellationToken,
    out: vscode.OutputChannel,
): Promise<CompletionResult> {
    if (!isContractDoc(doc) && !isTestDoc(doc)) return result;
    if (vscode.workspace.getConfiguration("qpi").get<string>("completionFilter") === "off") {
        return result;
    }

    // A null result still goes through the member branch: the clangd bug the fallback covers can
    // surface as an absent list, not only as an empty or word-list one.
    const items = result ? (Array.isArray(result) ? result : result.items) : [];
    const linePrefix = doc.lineAt(position.line).text.slice(0, position.character);
    const scope = completionScope(linePrefix);
    // clangd truncates its result set, so the list stays incomplete and is re-requested as the user types.
    const incomplete = result !== null && result !== undefined && !Array.isArray(result) ? result.isIncomplete : false;

    // A gtest may write std:: and the gtest macros, so only the member step applies there: narrowing
    // a test to the QPI surface would hide what it legitimately needs.
    if (isTestDoc(doc)) {
        if (scope.kind !== "member") return result;
        const members = await memberCompletions(doc, position, linePrefix, items, token, out);
        return new vscode.CompletionList(members, incomplete);
    }

    // A contract is narrowed to the QPI surface, which is walked from the prefix header clangd is using.
    if (!contractPrefixPath) return result;
    const allowed = qpiAllowedIdentifiers(contractPrefixPath, core);
    const documentNames = documentIdentifiers(doc.getText());
    let kept: vscode.CompletionItem[];

    if (scope.kind === "member") {
        kept = await memberCompletions(doc, position, linePrefix, items, token, out);
    } else if (scope.kind === "qualified") {
        kept = keepQualifiedScope(scope.qualifier, allowed, documentNames) ? items.filter((item) => keepMemberLabel(labelOf(item))) : [];
    } else {
        kept = items.filter((item) => keepCompletionLabel(labelOf(item), allowed, documentNames));
    }

    if (!filterReported) {
        filterReported = true;
        out.appendLine(`completion filtered to the QPI surface: kept ${kept.length} of ${items.length}`);
    }
    return new vscode.CompletionList(kept, incomplete);
}

// `State` from vscode-languageclient, which this extension does not depend on directly.
const CLANGD_CLIENT_RUNNING = 2;
// vscode-clangd replaces the client without waiting for the old one to release its commands, which
// only completes promptly once that client is past its own startup. Grace after it reports Running.
const CLANGD_SETTLE_MS = 1500;
const CLANGD_SETTLE_POLL_MS = 250;
const CLANGD_SETTLE_TIMEOUT_MS = 15000;

interface ClangdApi {
    languageClient?: {
        state?: number;
        middleware?: {
            provideCompletionItem?: (
                doc: vscode.TextDocument,
                position: vscode.Position,
                context: vscode.CompletionContext,
                token: vscode.CancellationToken,
                next: (...args: any[]) => Promise<CompletionResult>,
            ) => Promise<CompletionResult>;
        };
    };
}

// The clangd extension exposes its language client's middleware hook, read per request, so wrapping it
// here filters without taking the provider over; clangd.restart rebuilds the client, hence the re-check.
function ensureCompletionFilter(core: string | undefined, out: vscode.OutputChannel): boolean {
    const initialCore = contractCorePath ?? core;
    if (!initialCore) return false;
    const api: ClangdApi | undefined = vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd")?.exports?.getApi?.(1);
    const client = api?.languageClient;
    const middleware = client?.middleware;
    if (!client || !middleware) return false;
    if (filteredClients.has(client)) return true;

    const inner = middleware.provideCompletionItem;
    middleware.provideCompletionItem = async (doc, position, context, token, next) => {
        const result = inner ? await inner(doc, position, context, token, next) : await next(doc, position, context, token);
        try {
            return await filterCompletions(doc, position, result, contractCorePath ?? initialCore, token, out);
        } catch (error: any) {
            out.appendLine(`completion filter skipped: ${String(error?.message ?? error)}`);
            return result;
        }
    };
    filteredClients.add(client);
    return true;
}

// The clangd client comes up asynchronously; a document event may run before it exists, so keep
// retrying until the middleware is wrapped (and again after `clangd.restart` builds a new client).
let filterRetryActive = false;
function scheduleCompletionFilter(core: string | undefined, out: vscode.OutputChannel): void {
    if (ensureCompletionFilter(core, out) || filterRetryActive) return;
    filterRetryActive = true;
    let attempts = 0;
    const timer = setInterval(() => {
        attempts++;
        if (ensureCompletionFilter(core, out) || attempts >= 60) {
            clearInterval(timer);
            filterRetryActive = false;
        }
    }, 1000);
}

function clangdClient(): ClangdApi["languageClient"] {
    return vscode.extensions.getExtension("llvm-vs-code-extensions.vscode-clangd")?.exports?.getApi?.(1)?.languageClient;
}

// clangd never re-reads a database that appears after it resolved a file, so a new entry needs the
// restart; restarting a still-starting client kills it, and one that never comes up reads the DB itself.
async function clangdSettled(): Promise<boolean> {
    const deadline = Date.now() + CLANGD_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (clangdClient()?.state === CLANGD_CLIENT_RUNNING) {
            await new Promise((done) => setTimeout(done, CLANGD_SETTLE_MS));
            return clangdClient()?.state === CLANGD_CLIENT_RUNNING;
        }
        await new Promise((done) => setTimeout(done, CLANGD_SETTLE_POLL_MS));
    }
    return false;
}

function refreshClangd(root: string, out: vscode.OutputChannel, core?: string): void {
    // Opening a contract and then its test writes two entries. Dropping the second request would
    // leave that file on clangd's fallback flags, so a request arriving mid-restart runs after it.
    if (restartingRoots.has(root)) {
        pendingRefreshRoots.add(root);
        return;
    }
    restartingRoots.add(root);

    void clangdSettled().then(async (settled) => {
        // A client that never came up reads the finished database when it starts, so leave it alone.
        if (settled) {
            try {
                await vscode.commands.executeCommand("clangd.restart");
                out.appendLine("clangd restarted with QPI configuration");
            } catch (error: any) {
                out.appendLine(`clangd restart failed: ${String(error?.message ?? error)}`);
            }
        }
        restartingRoots.delete(root);
        scheduleCompletionFilter(core, out);

        if (pendingRefreshRoots.delete(root)) {
            refreshClangd(root, out, core);
        }
    });
}

function regenerateContract(doc: vscode.TextDocument, context: vscode.ExtensionContext, fallbackCore: string | undefined, out: vscode.OutputChannel): void {
    const root = workspaceRoot(doc);

    try {
        const sourceDetails = resolveProjectSourceDetails({
            filePath: doc.fileName,
            workspaceRoot: root,
            fallbackCorePath: fallbackCore,
        });
        if (!sourceDetails.corePath || !sourceDetails.wasiSysrootPath) {
            warnOnce("headers", "Qubic QPI: bundled headers are missing. Reinstall the extension from its VSIX or Marketplace.");
            return;
        }

        const result = generateClangdConfig({
            contractPath: doc.fileName,
            corePath: sourceDetails.corePath,
            dataRoot: dataRoot(context, root),
            workspaceRoot: root,
            name: sourceDetails.name,
            slot: sourceDetails.slot,
            dynCallees: sourceDetails.dynCallees,
            wasiSysrootPath: sourceDetails.wasiSysrootPath,
        });
        contractPrefixPath = result.prefixPath;
        contractAnalysisContexts.set(doc.fileName, sourceDetails.analysis);
        contractCorePath = sourceDetails.corePath;
        reportClangdConfig(result.clangdConfigured, result.dotClangdPath, result.dir);
        if (result.clangdConfigured && result.restartRequired) {
            refreshClangd(root, out, sourceDetails.corePath);
        }
        out.appendLine(`clangd config ready: ${result.name} (slot ${result.slot}) -> ${result.prefixPath}`);
    } catch (error: any) {
        out.appendLine(`clangd config failed: ${String(error?.message ?? error)}`);
    }
}

// From a gtest the contract is an external module spelled `Counter::Get_input`, which is exactly how a
// callee's structs are keyed — so the contract analyzes as one more callee of its own test.
function testAnalysisContext(details: ProjectSourceDetails): ProjectAnalysisContext {
    const open = vscode.workspace.textDocuments.find((candidate) => candidate.fileName === details.contractPath);
    let source: string;
    try {
        source = open ? open.getText() : readFileSync(details.contractPath, "utf8");
    } catch {
        return details.analysis;
    }

    const calleeSources = [...(details.analysis.calleeSources ?? []), { name: details.name, source, slot: details.slot }];
    return { ...details.analysis, calleeSources };
}

function regenerateTest(doc: vscode.TextDocument, context: vscode.ExtensionContext, fallbackCore: string | undefined, out: vscode.OutputChannel): void {
    const root = workspaceRoot(doc);
    const project = findProjectRoot(doc.fileName);
    const config = project ? loadConfig(join(project, QINIT_JSON)) : {};
    const configuredContract = project && config.contract ? resolve(join(project, config.contract)) : undefined;

    let contractPath = configuredContract && existsSync(configuredContract) ? configuredContract : undefined;
    if (!contractPath) {
        const candidate = selectTestContract(doc.getText(), findContractCandidates(root), doc.fileName);
        contractPath = candidate?.path;
    }

    if (!contractPath) {
        warnOnce(`test:${doc.uri.toString()}`, `Qubic QPI: cannot determine the contract for ${doc.fileName}.`);
        return;
    }

    try {
        const sourceDetails = resolveProjectSourceDetails({
            filePath: contractPath,
            workspaceRoot: root,
            fallbackCorePath: fallbackCore,
        });
        if (!sourceDetails.corePath || !sourceDetails.wasiSysrootPath) {
            warnOnce("headers", "Qubic QPI: bundled headers are missing. Reinstall the extension from its VSIX or Marketplace.");
            return;
        }

        const result = generateTestClangdConfig({
            contractPath,
            testPath: doc.fileName,
            corePath: sourceDetails.corePath,
            dataRoot: dataRoot(context, root),
            workspaceRoot: root,
            name: sourceDetails.name,
            slot: sourceDetails.slot,
            dynCallees: sourceDetails.dynCallees,
            wasiSysrootPath: sourceDetails.wasiSysrootPath,
        });
        // A gtest completes against the contract it exercises, so it analyzes under that contract's context.
        contractAnalysisContexts.set(doc.fileName, testAnalysisContext(sourceDetails));
        reportClangdConfig(result.clangdConfigured, result.dotClangdPath, dirname(result.dbPath));
        if (result.clangdConfigured && result.restartRequired) {
            refreshClangd(root, out, sourceDetails.corePath);
        }
        out.appendLine(`gtest clangd config ready: ${doc.fileName} -> ${result.prefixPath}`);
    } catch (error: any) {
        out.appendLine(`gtest clangd config failed: ${String(error?.message ?? error)}`);
    }
}

function regenerateDocument(doc: vscode.TextDocument, context: vscode.ExtensionContext, core: string | undefined, out: vscode.OutputChannel): void {
    if (!isContractDoc(doc) && !isTestDoc(doc)) return;
    if (isContractDoc(doc)) {
        regenerateContract(doc, context, core, out);
    } else {
        regenerateTest(doc, context, core, out);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const out = vscode.window.createOutputChannel("Qubic QPI");
    const core = bundledCore(context);
    const diagnostics = new QpiDiagnostics(
        (doc) =>
            resolveProjectSourceDetails({
                filePath: doc.fileName,
                workspaceRoot: workspaceRoot(doc),
                fallbackCorePath: core,
            }).analysis,
    );
    context.subscriptions.push(out, diagnostics);

    const onDocument = (doc?: vscode.TextDocument) => {
        if (!doc) return;
        regenerateDocument(doc, context, core, out);
        scheduleCompletionFilter(core, out);
        diagnostics.refresh(doc);
    };
    const onSave = (doc: vscode.TextDocument) => {
        const project = findProjectRoot(doc.fileName);
        const refreshProject = doc.uri.scheme === "file" && (basename(doc.fileName) === QINIT_JSON || (project !== undefined && isContractDoc(doc)));
        if (refreshProject) {
            const configFile = basename(doc.fileName) === QINIT_JSON ? doc.fileName : join(project!, QINIT_JSON);
            for (const contract of projectContractDocuments(configFile, vscode.workspace.textDocuments)) {
                diagnostics.clear(contract.uri);
                onDocument(contract);
            }
            return;
        }
        onDocument(doc);
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(onDocument),
        vscode.workspace.onDidSaveTextDocument(onSave),
        vscode.workspace.onDidChangeTextDocument((event) => diagnostics.schedule(event.document)),
        vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.clear(doc.uri)),
        vscode.languages.registerHoverProvider({ scheme: "file", pattern: "**/*.{h,hpp,hxx,cpp,cc,cxx}" }, new IdlHover(diagnostics)),
        vscode.languages.registerCodeActionsProvider(
            { scheme: "file", pattern: "**/*.{h,hpp,hxx,cpp,cc,cxx}" },
            new QpiCodeActions(diagnostics),
            QpiCodeActions.metadata,
        ),
        vscode.commands.registerCommand("qpi.regenerateConfig", () => {
            const doc = vscode.window.activeTextEditor?.document;
            if (!doc || (!isContractDoc(doc) && !isTestDoc(doc))) {
                vscode.window.showInformationMessage("Qubic QPI: open a contract or test first.");
                return;
            }
            regenerateDocument(doc, context, core, out);
            diagnostics.refresh(doc);
            vscode.window.showInformationMessage("Qubic QPI: clangd config regenerated.");
        }),
    );

    onDocument(vscode.window.activeTextEditor?.document);
}

export function deactivate(): void {}
