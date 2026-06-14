// Qubic QPI extension.
//   M1 — clangd enablement: on opening/saving a contract header in a qinit project, (re)generate the
//        per-contract clangd compile DB so the bundled vscode-clangd gives full IntelliSense with no
//        manual `#include "qpi.h"`.
//   M2 — live QPI diagnostics (Tier-A lexer + IDL checks), IDL hover, and a command palette that
//        shells the `qinit` CLI for build/deploy/call/gen/test/up.
import * as vscode from "vscode";
import { join, resolve } from "node:path";
import { resolveCore, wasiSdkPaths, loadConfig } from "@qinit/core/project";
import { generateClangdConfig } from "./clangd-config";
import { findProjectRoot, isContractDoc, QINIT_JSON } from "./project-util";
import { QpiDiagnostics } from "./diagnostics";
import { IdlHover } from "./idl-hover";
import { registerCommands } from "./commands";
import { VerifyRunner } from "./verify-runner";
import { QpiCodeLens } from "./codelens";
import { QpiCodeActions } from "./codeactions";

let warnedAt = 0;
function warnOncePerMinute(msg: string): void {
  const now = Date.now();
  if (now - warnedAt > 60_000) { warnedAt = now; vscode.window.showWarningMessage(msg); }
}

// (Re)generate the clangd compile DB for a contract document (M1). Silent for non-contracts and
// non-projects; warns (at most once a minute) when the toolchain isn't synced.
function regenerateClangd(doc: vscode.TextDocument, out: vscode.OutputChannel): void {
  if (!isContractDoc(doc)) return;
  const root = findProjectRoot(doc.fileName);
  if (!root) return;

  const cfg = loadConfig(join(root, QINIT_JSON));
  const settingCore = vscode.workspace.getConfiguration("qpi").get<string>("core") || undefined;

  let core: string;
  try {
    core = resolveCore(settingCore, cfg.core);
  } catch (e: any) {
    out.appendLine("resolveCore: " + String(e?.message ?? e));
    warnOncePerMinute("Qubic QPI: core headers not found — run `qinit up`, or set the `qpi.core` setting / QINIT_CORE.");
    return;
  }

  const wasi = wasiSdkPaths();
  if (!wasi) {
    warnOncePerMinute("Qubic QPI: the wasm compiler (wasi-sdk) isn't synced — run `qinit up`.");
    return;
  }

  // Use qinit.json's name/slot only for the project's primary contract; other headers default to
  // their basename + slot 28 so multi-header projects each get a correct TU.
  const primary = !!cfg.contract && resolve(join(root, cfg.contract)) === resolve(doc.fileName);
  try {
    const r = generateClangdConfig({
      contractPath: doc.fileName,
      corePath: core,
      wasiClang: wasi.clang,
      wasiSysroot: wasi.sysroot,
      workspaceRoot: root,
      name: primary ? cfg.name : undefined,
      slot: primary ? cfg.slot : undefined,
    });
    out.appendLine(`clangd config ready: ${r.name} (slot ${r.slot}) -> ${r.prefixPath}`);
  } catch (e: any) {
    out.appendLine("generate failed: " + String(e?.message ?? e));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Qubic QPI");
  const diags = new QpiDiagnostics();
  const verify = new VerifyRunner();
  context.subscriptions.push(out, diags, verify);

  // open/save: regenerate the clangd DB, run the instant Tier-A diagnostics, and kick off the
  // authoritative Tier-B contractverify pass (a CLI shell-out, save-frequency).
  const onDoc = (doc?: vscode.TextDocument) => {
    if (!doc) return;
    regenerateClangd(doc, out);
    diags.refresh(doc);
    verify.run(doc);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(onDoc),
    vscode.workspace.onDidSaveTextDocument(onDoc),
    vscode.workspace.onDidChangeTextDocument((e) => diags.schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => { diags.clear(d.uri); verify.clear(d.uri); }),
    vscode.languages.registerHoverProvider({ scheme: "file", pattern: "**/*.{h,hpp,cpp}" }, new IdlHover()),
    vscode.languages.registerCodeLensProvider({ scheme: "file", pattern: "**/*.{h,hpp,cpp}" }, new QpiCodeLens()),
    vscode.languages.registerCodeActionsProvider({ scheme: "file", pattern: "**/*.{h,hpp,cpp}" }, new QpiCodeActions(), QpiCodeActions.metadata),
    vscode.commands.registerCommand("qpi.regenerateConfig", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) { vscode.window.showInformationMessage("Qubic QPI: open a contract header first."); return; }
      regenerateClangd(doc, out);
      diags.refresh(doc);
      vscode.window.showInformationMessage("Qubic QPI: clangd config regenerated.");
    }),
  );
  registerCommands(context);

  onDoc(vscode.window.activeTextEditor?.document); // handle the already-open editor on activation
}

export function deactivate(): void { /* subscriptions are disposed by VS Code */ }
