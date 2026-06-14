// Command palette + (later) CodeLens actions. All heavy work shells the installed `qinit` CLI in an
// integrated terminal — the extension never runs the Bun-backed build/deploy in-process (see the
// runtime boundary in the plan). A single reused "qinit" terminal keeps output in one place.
import * as vscode from "vscode";

function runInTerminal(cmd: string): void {
  const term = vscode.window.terminals.find((t) => t.name === "qinit") ?? vscode.window.createTerminal("qinit");
  term.show();
  term.sendText(cmd);
}

// Active file, quoted for the shell (only when it's a real on-disk file).
function activeFile(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  return doc && doc.uri.scheme === "file" ? `"${doc.fileName}"` : undefined;
}

export function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: () => void) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const f = () => activeFile();

  // `qinit build` reads --contract (not a positional); deploy/verify-via-build accept the path.
  reg("qpi.build", () => runInTerminal(f() ? `qinit build --contract ${f()}` : "qinit build"));
  reg("qpi.deploy", () => runInTerminal(f() ? `qinit deploy ${f()}` : "qinit deploy"));
  reg("qpi.call", () => runInTerminal("qinit call"));
  reg("qpi.gen", () => runInTerminal("qinit gen"));
  reg("qpi.test", () => runInTerminal("qinit test"));
  reg("qpi.up", () => runInTerminal("qinit up"));
  reg("qpi.doctor", () => runInTerminal("qinit doctor"));
  reg("qpi.new", () => runInTerminal("qinit new"));
}
