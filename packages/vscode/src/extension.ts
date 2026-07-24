import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as vscode from "vscode";
import { loadConfig } from "@qinit/core/project";
import { QpiCodeActions } from "./codeactions";
import { generateClangdConfig, generateTestClangdConfig } from "./clangd-config";
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
  const qpi = join(core, "src", "contracts", "qpi.h");
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

function restartClangd(root: string, out: vscode.OutputChannel): void {
  if (restartingRoots.has(root)) return;
  restartingRoots.add(root);
  void vscode.commands.executeCommand("clangd.restart").then(
    () => {
      restartingRoots.delete(root);
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
    reportClangdConfig(result.clangdConfigured, result.dotClangdPath, result.dir);
    if (result.clangdConfigured && result.restartRequired) restartClangd(root, out);
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
  let name = contractPath ? config.name : undefined;
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
    if (result.clangdConfigured && result.restartRequired) restartClangd(root, out);
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
