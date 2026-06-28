// Qubic QPI extension.
//   M1 — clangd enablement: on opening/saving a contract header in a qinit project, (re)generate the
//        per-contract clangd compile DB so the bundled vscode-clangd gives full IntelliSense with no
//        manual `#include "qpi.h"`.
//   M2 — live QPI diagnostics (Tier-A lexer + IDL checks), IDL hover, and an Array<T,N> quick-fix.
// Deliberately UI-light: no build/deploy/call buttons (CodeLens) or palette actions — use the `qinit`
// CLI in a terminal for those. The extension is purely editor smarts.
import * as vscode from "vscode";
import { join, resolve } from "node:path";
import { resolveCore, wasiSdkPaths, loadConfig } from "@qinit/core/project";
import { generateClangdConfig, generateTestClangdConfig } from "./clangd-config";
import { dynCalleesFromNode, unresolvedCalleeRefs } from "./callees";
import { findProjectRoot, isContractDoc, isTestDoc, QINIT_JSON } from "./project-util";
import { parseContractDef, type DynCallees } from "@qinit/build/intercontract";
import { QpiDiagnostics } from "./diagnostics";
import { IdlHover } from "./idl-hover";
import { VerifyRunner } from "./verify-runner";
import { QpiCodeActions } from "./codeactions";

let warnedAt = 0;
function warnOncePerMinute(msg: string): void {
  const now = Date.now();
  if (now - warnedAt > 60_000) { warnedAt = now; vscode.window.showWarningMessage(msg); }
}

// (Re)generate the clangd compile DB for a contract document (M1). Silent for non-contracts and
// non-projects; warns (at most once a minute) when the toolchain isn't synced. Async because it
// resolves inter-contract callees from the running node (best-effort) — never rejects.
async function regenerateClangd(doc: vscode.TextDocument, out: vscode.OutputChannel, calleeDiags: vscode.DiagnosticCollection): Promise<void> {
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
    warnOncePerMinute("Qubic QPI: core headers not found — run `qinit node run`, or set the `qpi.core` setting / QINIT_CORE.");
    return;
  }

  const wasi = wasiSdkPaths();
  if (!wasi) {
    warnOncePerMinute("Qubic QPI: the wasm compiler (wasi-sdk) isn't synced — run `qinit node run`.");
    return;
  }

  // Resolve qinit-deployed inter-contract callees from the running node's stored sources (best-effort:
  // {} if this contract calls nobody, or the node is down). In-core callees resolve via contract_def.h.
  let dynCallees: DynCallees = {};
  try {
    const rpcBase = vscode.workspace.getConfiguration("qpi").get<string>("rpc") || cfg.rpc || "http://127.0.0.1:41841";
    dynCallees = await dynCalleesFromNode(rpcBase, doc.getText(), join(root, ".qinit", "clangd", "callees"));
  } catch (e: any) {
    out.appendLine("dynCallees: " + String(e?.message ?? e));
  }

  // Friendly diagnostic for a callee that resolves to NEITHER an in-core contract nor a deployed one —
  // turns clangd's raw "undeclared identifier <Callee>" into an actionable hint at the call site.
  try {
    const known = new Set<string>([...parseContractDef(core).keys(), ...Object.keys(dynCallees)]);
    calleeDiags.set(doc.uri, unresolvedCalleeRefs(doc.getText(), known).map((r) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(doc.positionAt(r.offset), doc.positionAt(r.offset + r.length)),
        `Callee \`${r.name}\` isn't a known contract — deploy it (\`qinit deploy\`) or run \`qinit node run\`, otherwise its CALL_OTHER_CONTRACT_* references can't resolve.`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = "qpi";
      d.code = "qpi/unknown-callee";
      return d;
    }));
  } catch {
    calleeDiags.delete(doc.uri); // no core / unreadable contract_def.h — don't assert anything
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
      dynCallees,
    });
    const n = Object.keys(dynCallees).length;
    out.appendLine(`clangd config ready: ${r.name} (slot ${r.slot})${n ? `, ${n} callee(s) from node` : ""} -> ${r.prefixPath}`);
  } catch (e: any) {
    out.appendLine("generate failed: " + String(e?.message ?? e));
  }
}

// (Re)generate the clangd compile DB for a gtest TEST file: a combined contract+test TU so clangd resolves
// TEST / EXPECT_* / ContractTest and the contract's <Name>::Foo_input types. The test pairs with the
// project's primary contract (qinit.json `contract`). Silent for non-tests / non-projects.
function regenerateTestClangd(doc: vscode.TextDocument, out: vscode.OutputChannel): void {
  if (!isTestDoc(doc)) return;
  const root = findProjectRoot(doc.fileName);
  if (!root) return;

  const cfg = loadConfig(join(root, QINIT_JSON));
  if (!cfg.contract) {
    out.appendLine("gtest clangd: qinit.json has no `contract` to pair the test against");
    return;
  }

  const settingCore = vscode.workspace.getConfiguration("qpi").get<string>("core") || undefined;
  let core: string;
  try {
    core = resolveCore(settingCore, cfg.core);
  } catch (e: any) {
    out.appendLine("resolveCore: " + String(e?.message ?? e));
    return;
  }

  const wasi = wasiSdkPaths();
  if (!wasi) {
    warnOncePerMinute("Qubic QPI: the wasm compiler (wasi-sdk) isn't synced — run `qinit node run`.");
    return;
  }

  try {
    const r = generateTestClangdConfig({
      contractPath: resolve(join(root, cfg.contract)),
      testPath: doc.fileName,
      corePath: core,
      wasiClang: wasi.clang,
      wasiSysroot: wasi.sysroot,
      workspaceRoot: root,
      name: cfg.name,
      slot: cfg.slot,
    });
    out.appendLine(`gtest clangd config ready: ${doc.fileName} -> ${r.prefixPath}`);
  } catch (e: any) {
    out.appendLine("gtest generate failed: " + String(e?.message ?? e));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Qubic QPI");
  const diags = new QpiDiagnostics();
  const verify = new VerifyRunner();
  const calleeDiags = vscode.languages.createDiagnosticCollection("qpi-callee"); // unresolved inter-contract callees
  context.subscriptions.push(out, diags, verify, calleeDiags);

  // open/save: regenerate the clangd DB, run the instant Tier-A diagnostics, and kick off the
  // authoritative Tier-B contractverify pass (a CLI shell-out, save-frequency).
  const onDoc = (doc?: vscode.TextDocument) => {
    if (!doc) return;
    void regenerateClangd(doc, out, calleeDiags); // async (node callee resolution); never rejects — contracts only
    regenerateTestClangd(doc, out); // gtest .cpp -> its own combined-TU clangd entry; no-op for contracts
    diags.refresh(doc); // Tier-A QPI lint — gates on isContractDoc, so it skips tests
    verify.run(doc); // Tier-B contractverify — gates on isContractDoc, so it skips tests
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(onDoc),
    vscode.workspace.onDidSaveTextDocument(onDoc),
    vscode.workspace.onDidChangeTextDocument((e) => diags.schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => { diags.clear(d.uri); verify.clear(d.uri); calleeDiags.delete(d.uri); }),
    vscode.languages.registerHoverProvider({ scheme: "file", pattern: "**/*.{h,hpp,cpp}" }, new IdlHover()),
    vscode.languages.registerCodeActionsProvider({ scheme: "file", pattern: "**/*.{h,hpp,cpp}" }, new QpiCodeActions(), QpiCodeActions.metadata),
    vscode.commands.registerCommand("qpi.regenerateConfig", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) { vscode.window.showInformationMessage("Qubic QPI: open a contract header first."); return; }
      await regenerateClangd(doc, out, calleeDiags);
      diags.refresh(doc);
      vscode.window.showInformationMessage("Qubic QPI: clangd config regenerated.");
    }),
  );

  onDoc(vscode.window.activeTextEditor?.document); // handle the already-open editor on activation
}

export function deactivate(): void { /* subscriptions are disposed by VS Code */ }
