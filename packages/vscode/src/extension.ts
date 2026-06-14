// Qubic QPI extension — M1: clangd enablement.
// On opening/saving a contract header inside a qinit project, (re)generate the per-contract clangd
// compile DB so the bundled vscode-clangd serves CLion-grade IntelliSense (completion, hover,
// go-to-def into qpi.h) with NO manual `#include "qpi.h"`. Heavy actions (build/deploy/verify) shell
// the `qinit` CLI and are added in later milestones; this milestone is purely the enablement.
import * as vscode from "vscode";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { resolveCore, wasiSdkPaths, loadConfig } from "@qinit/core/project";
import { generateClangdConfig } from "./clangd-config";

const QINIT_JSON = "qinit.json";

// Walk up from a file to the nearest qinit.json; that directory is the project root.
function findProjectRoot(file: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, QINIT_JSON))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function isContractDoc(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  return doc.languageId === "cpp" || /\.(h|hpp)$/.test(doc.fileName);
}

let warnedAt = 0;
function warnOncePerMinute(msg: string): void {
  const now = Date.now();
  if (now - warnedAt > 60_000) { warnedAt = now; vscode.window.showWarningMessage(msg); }
}

function regenerate(doc: vscode.TextDocument, out: vscode.OutputChannel): void {
  if (!isContractDoc(doc)) return;
  const root = findProjectRoot(doc.fileName);
  if (!root) return; // not a qinit project — stay silent

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

  // Use qinit.json's name/slot only for the project's primary contract; any other opened .h defaults
  // to its basename + slot 28 (so multi-header projects each get a correct TU).
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
    out.appendLine(`clangd config ready: ${r.name} (slot ${r.slot}) -> ${r.wrapperPath}`);
  } catch (e: any) {
    out.appendLine("generate failed: " + String(e?.message ?? e));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Qubic QPI");
  context.subscriptions.push(out);
  const run = (doc?: vscode.TextDocument) => { if (doc) regenerate(doc, out); };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidSaveTextDocument(run),
    vscode.commands.registerCommand("qpi.regenerateConfig", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) { vscode.window.showInformationMessage("Qubic QPI: open a contract header first."); return; }
      regenerate(doc, out);
      vscode.window.showInformationMessage("Qubic QPI: clangd config regenerated.");
    }),
  );

  run(vscode.window.activeTextEditor?.document); // handle the already-open editor on activation
}

export function deactivate(): void { /* nothing to tear down */ }
