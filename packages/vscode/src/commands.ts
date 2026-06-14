// Command palette + CodeLens actions. All heavy work shells the installed `qinit` CLI in an integrated
// terminal — the extension never runs the Bun-backed build/deploy in-process (see the runtime boundary
// in the plan). The terminal is rooted at the project (so qinit.json resolves), and the binary is
// configurable via `qpi.qinitPath` (default `qinit` on PATH; point it at a built binary for a checkout).
import * as vscode from "vscode";
import { dirname } from "node:path";
import { findProjectRoot } from "./project-util";

function qinit(): string {
  return vscode.workspace.getConfiguration("qpi").get<string>("qinitPath") || "qinit";
}

// Project root of the active file (so `qinit.json` + relative paths resolve), else the file's directory.
function projectCwd(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== "file") return undefined;
  return findProjectRoot(doc.fileName) ?? dirname(doc.fileName);
}

function runInTerminal(cmd: string): void {
  const cwd = projectCwd();
  const term = vscode.window.terminals.find((t) => t.name === "qinit") ?? vscode.window.createTerminal({ name: "qinit", cwd });
  term.show();
  term.sendText(cmd);
}

// Active file path, quoted for the shell (only when it's a real on-disk file).
function activeFileArg(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  return doc && doc.uri.scheme === "file" ? `"${doc.fileName}"` : undefined;
}

export function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: () => void) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const f = () => activeFileArg();
  // `qinit build` reads --contract (not a positional); deploy accepts the path positionally.
  reg("qpi.build", () => runInTerminal(f() ? `${qinit()} build --contract ${f()}` : `${qinit()} build`));
  reg("qpi.deploy", () => runInTerminal(f() ? `${qinit()} deploy ${f()}` : `${qinit()} deploy`));
  reg("qpi.call", () => runInTerminal(`${qinit()} call`));
  reg("qpi.gen", () => runInTerminal(`${qinit()} gen`));
  reg("qpi.test", () => runInTerminal(`${qinit()} test`));
  reg("qpi.up", () => runInTerminal(`${qinit()} up`));
  reg("qpi.doctor", () => runInTerminal(`${qinit()} doctor`));
  reg("qpi.new", () => runInTerminal(`${qinit()} new`));
}
