import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as vscode from "vscode";
import { loadConfig } from "@qinit/core/project";
import { QpiCodeActions } from "./codeactions";
import { generateClangdConfig, generateTestClangdConfig } from "./clangd-config";
import {
  completionScope,
  documentIdentifiers,
  keepCompletionLabel,
  keepMemberLabel,
  keepQualifiedScope,
  qpiAllowedIdentifiers,
} from "./completion-filter";
import { QpiDiagnostics } from "./diagnostics";
import { IdlHover } from "./idl-hover";
import {
  configuredContractIdentity,
  findContractCandidates,
  findProjectRoot,
  isContractDoc,
  isTestDoc,
  projectContractDocuments,
  QINIT_JSON,
  selectTestContract,
} from "./project-util";

const warned = new Set<string>();
const restartingRoots = new Set<string>();
const filteredClients = new WeakSet<object>();
// The prefix header clangd is using for the active contract: the root of the allowed-identifier walk.
let contractPrefixPath: string | undefined;
let filterReported = false;

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  vscode.window.showWarningMessage(message);
}

function workspaceRoot(doc: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ??
    findProjectRoot(doc.fileName) ??
    dirname(doc.fileName)
  );
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

function reportClangdConfig(
  configured: boolean,
  configPath: string,
  databaseDir: string,
): void {
  if (configured) return;
  warnOnce(
    `clangd:${configPath}`,
    `Qubic QPI: ${configPath} is user-owned. Point its CompilationDatabase to ${databaseDir}.`,
  );
}

type CompletionResult =
  | vscode.CompletionItem[]
  | vscode.CompletionList
  | null
  | undefined;

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

// clangd offers every symbol the translation unit can see; a contract may write only the QPI surface.
function filterCompletions(
  doc: vscode.TextDocument,
  position: vscode.Position,
  result: CompletionResult,
  core: string,
  out: vscode.OutputChannel,
): CompletionResult {
  if (!result || !contractPrefixPath || !isContractDoc(doc)) return result;
  if (vscode.workspace.getConfiguration("qpi").get<string>("completionFilter") === "off") {
    return result;
  }

  const items = Array.isArray(result) ? result : result.items;
  const linePrefix = doc.lineAt(position.line).text.slice(0, position.character);
  const scope = completionScope(linePrefix);
  const allowed = qpiAllowedIdentifiers(contractPrefixPath, core);
  const documentNames = documentIdentifiers(doc.getText());
  let kept: vscode.CompletionItem[];

  if (scope.kind === "member") {
    // A member list is already scoped by its type — only QPI's reserved names have to go.
    kept = items.filter((item) => keepMemberLabel(labelOf(item)));
  } else if (scope.kind === "qualified") {
    // `QPI::`, `OI::Price::` and the contract's own types stay whole; `std::` and friends offer nothing.
    kept = keepQualifiedScope(scope.qualifier, allowed, documentNames)
      ? items.filter((item) => keepMemberLabel(labelOf(item)))
      : [];
  } else {
    kept = items.filter((item) => keepCompletionLabel(labelOf(item), allowed, documentNames));
  }

  if (!filterReported) {
    filterReported = true;
    out.appendLine(`completion filtered to the QPI surface: kept ${kept.length} of ${items.length}`);
  }
  // clangd truncates its result set, so the list stays incomplete and is re-requested as the user types.
  return new vscode.CompletionList(kept, Array.isArray(result) ? false : result.isIncomplete);
}

interface ClangdApi {
  languageClient?: {
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

// The clangd extension owns the completion provider, but exposes its language client, and its middleware
// hook is read per request — so wrapping it here filters the list without taking the provider over.
// `clangd.restart` builds a fresh client, hence the re-check on every document event.
function ensureCompletionFilter(core: string | undefined, out: vscode.OutputChannel): void {
  if (!core) return;
  const api: ClangdApi | undefined = vscode.extensions
    .getExtension("llvm-vs-code-extensions.vscode-clangd")
    ?.exports?.getApi?.(1);
  const client = api?.languageClient;
  const middleware = client?.middleware;
  if (!client || !middleware || filteredClients.has(client)) return;

  const inner = middleware.provideCompletionItem;
  middleware.provideCompletionItem = async (doc, position, context, token, next) => {
    const result = inner
      ? await inner(doc, position, context, token, next)
      : await next(doc, position, context, token);
    try {
      return filterCompletions(doc, position, result, core, out);
    } catch (error: any) {
      out.appendLine(`completion filter skipped: ${String(error?.message ?? error)}`);
      return result;
    }
  };
  filteredClients.add(client);
}

function restartClangd(root: string, out: vscode.OutputChannel, core?: string): void {
  if (restartingRoots.has(root)) return;
  restartingRoots.add(root);
  void vscode.commands.executeCommand("clangd.restart").then(
    () => {
      restartingRoots.delete(root);
      ensureCompletionFilter(core, out);
      out.appendLine("clangd restarted with QPI configuration");
    },
    (error) => {
      restartingRoots.delete(root);
      out.appendLine(`clangd restart failed: ${String(error?.message ?? error)}`);
    },
  );
}

function regenerateContract(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
  core: string,
  out: vscode.OutputChannel,
): void {
  const root = workspaceRoot(doc);
  const identity = configuredContractIdentity(doc.fileName);

  try {
    const result = generateClangdConfig({
      contractPath: doc.fileName,
      corePath: core,
      dataRoot: dataRoot(context, root),
      workspaceRoot: root,
      name: identity.name,
      slot: identity.slot,
    });
    contractPrefixPath = result.prefixPath;
    reportClangdConfig(result.clangdConfigured, result.dotClangdPath, result.dir);
    if (result.clangdConfigured && result.restartRequired) restartClangd(root, out, core);
    out.appendLine(
      `clangd config ready: ${result.name} (slot ${result.slot}) -> ${result.prefixPath}`,
    );
  } catch (error: any) {
    out.appendLine(`clangd config failed: ${String(error?.message ?? error)}`);
  }
}

function regenerateTest(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
  core: string,
  out: vscode.OutputChannel,
): void {
  const root = workspaceRoot(doc);
  const project = findProjectRoot(doc.fileName);
  const config = project ? loadConfig(join(project, QINIT_JSON)) : {};
  const configuredContract =
    project && config.contract ? resolve(join(project, config.contract)) : undefined;

  let contractPath =
    configuredContract && existsSync(configuredContract) ? configuredContract : undefined;
  let name = contractPath ? config.contractName : undefined;
  if (!contractPath) {
    const candidate = selectTestContract(
      doc.getText(),
      findContractCandidates(root),
    );
    contractPath = candidate?.path;
    name = candidate?.stateType;
  }

  if (!contractPath) {
    warnOnce(
      `test:${doc.uri.toString()}`,
      `Qubic QPI: cannot determine the contract for ${doc.fileName}.`,
    );
    return;
  }

  try {
    const result = generateTestClangdConfig({
      contractPath,
      testPath: doc.fileName,
      corePath: core,
      dataRoot: dataRoot(context, root),
      workspaceRoot: root,
      name,
      slot: config.slot,
    });
    reportClangdConfig(
      result.clangdConfigured,
      result.dotClangdPath,
      dirname(result.dbPath),
    );
    if (result.clangdConfigured && result.restartRequired) restartClangd(root, out, core);
    out.appendLine(`gtest clangd config ready: ${doc.fileName} -> ${result.prefixPath}`);
  } catch (error: any) {
    out.appendLine(`gtest clangd config failed: ${String(error?.message ?? error)}`);
  }
}

function regenerateDocument(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
  core: string | undefined,
  out: vscode.OutputChannel,
): void {
  if (!isContractDoc(doc) && !isTestDoc(doc)) return;
  if (!core) {
    warnOnce(
      "headers",
      "Qubic QPI: bundled headers are missing. Reinstall the extension from its VSIX or Marketplace.",
    );
    return;
  }
  if (isContractDoc(doc)) {
    regenerateContract(doc, context, core, out);
  } else {
    regenerateTest(doc, context, core, out);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Qubic QPI");
  const diagnostics = new QpiDiagnostics();
  const core = bundledCore(context);
  context.subscriptions.push(out, diagnostics);

  const onDocument = (doc?: vscode.TextDocument) => {
    if (!doc) return;
    regenerateDocument(doc, context, core, out);
    ensureCompletionFilter(core, out);
    diagnostics.refresh(doc);
  };
  const onSave = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme === "file" && basename(doc.fileName) === QINIT_JSON) {
      for (const contract of projectContractDocuments(
        doc.fileName,
        vscode.workspace.textDocuments,
      )) {
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
    vscode.languages.registerHoverProvider(
      { scheme: "file", pattern: "**/*.{h,hpp,hxx,cpp,cc,cxx}" },
      new IdlHover(diagnostics),
    ),
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
