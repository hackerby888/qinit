// Command router. One-shot: each command renders, does its work, then exits.
import { Component, useEffect, type ReactNode } from "react";
import { Box, Text, useApp } from "ink";
import { Doctor } from "./commands/doctor";
import { Smoke } from "./commands/smoke";
import { Node } from "./commands/node";
import { NodeRun } from "./commands/node-run";
import { Ext } from "./commands/ext";
import { Dev } from "./commands/dev";
import { Build } from "./commands/build";
import { Gen } from "./commands/gen";
import { Deploy } from "./commands/deploy";
import { Verify } from "./commands/verify";
import { Test } from "./commands/test";
import { Call } from "./commands/call";
import { Ls } from "./commands/ls";
import { Debug } from "./commands/debug";
import { State } from "./commands/state";
import { Clean } from "./commands/clean";
import { Cheat } from "./commands/cheat";
import { Seed } from "./commands/seed";
import { Tick } from "./commands/tick";
import { Epoch } from "./commands/epoch";
import { ThemeCmd } from "./commands/theme";
import { ModeCmd } from "./commands/mode";
import { System } from "./commands/system";
import { Update } from "./commands/update";
import { Uninstall } from "./commands/uninstall";
import { New } from "./commands/new";
import { Help, Usage } from "./commands/help";
import { Version } from "./commands/version";
import { nearest } from "./args";
import { META, COMMANDS } from "./meta";

// Catch a render-time throw in any command so the CLI shows one clean line + exits 1, never a raw React crash.
function Crash({ err }: { err: Error }) {
  const { exit } = useApp();
  useEffect(() => { process.exitCode = 1; const t = setTimeout(() => exit(), 30); return () => clearTimeout(t); }, []);
  return <Box><Text color="red">✗ qinit crashed: {err.message}</Text></Box>;
}
class ErrorBoundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() { return this.state.err ? <Crash err={this.state.err} /> : this.props.children; }
}

export function App({ command, args }: { command: string; args: string[] }) {
  return <ErrorBoundary>{route(command, args)}</ErrorBoundary>;
}

// Commands that were removed/renamed — point the old name at its replacement instead of a fuzzy "did you mean".
const REMOVED: Record<string, string> = { up: "node run" };

function route(command: string, args: string[]): ReactNode {
  // Per-command help: `qinit <cmd> --help` / `-h` shows that command's usage + flags.
  const canon = command === "cheat" || command === "--cheat-sheet" ? "cheat-sheet"
    : command === "--version" || command === "-v" ? "version" : command;
  if ((args.includes("--help") || args.includes("-h")) && canon in META) return <Usage cmd={canon} />;
  switch (command) {
    case "new":
      return <New args={args} />;
    case "doctor":
      return <Doctor />;
    case "node":
      return args[0] === "run" ? <NodeRun args={args} /> : <Node args={args} />;
    case "ext":
      return <Ext args={args} />;
    case "dev":
      return <Dev args={args} />;
    case "smoke":
      return <Smoke />;
    case "build":
      return <Build args={args} />;
    case "gen":
      return <Gen args={args} />;
    case "deploy":
      return <Deploy args={args} />;
    case "verify":
      return <Verify args={args} />;
    case "test":
      return <Test args={args} />;
    case "call":
      return <Call args={args} />;
    case "ls":
      return <Ls args={args} />;
    case "debug":
      return <Debug args={args} />;
    case "state":
      return <State args={args} />;
    case "clean":
      return <Clean args={args} />;
    case "seed":
      return <Seed args={args} />;
    case "tick":
      return <Tick args={args} />;
    case "epoch":
      return <Epoch args={args} />;
    case "theme":
      return <ThemeCmd args={args} />;
    case "mode":
      return <ModeCmd args={args} />;
    case "system":
      return <System args={args} />;
    case "cheat-sheet":
    case "cheat":
    case "--cheat-sheet":
      return <Cheat />;
    case "self-update":
      return <Update args={args} />;
    case "uninstall":
      return <Uninstall args={args} />;
    case "version":
    case "--version":
    case "-v":
      return <Version />;
    case "help":
    case "--help":
    case "-h":
      return <Help />;
    default:
      return <Help unknown={!command.startsWith("-")} command={command} suggestion={REMOVED[command] ?? nearest(command, COMMANDS)} />;
  }
}
