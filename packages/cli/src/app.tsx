// Command router. One-shot: each command renders, does its work, then exits.
import { Component, useEffect, type ReactNode } from "react";
import { Box, Text, useApp } from "ink";
import { Doctor } from "./commands/doctor";
import { Smoke } from "./commands/smoke";
import { Node } from "./commands/node";
import { Up } from "./commands/up";
import { Dev } from "./commands/dev";
import { Build } from "./commands/build";
import { Gen } from "./commands/gen";
import { Deploy } from "./commands/deploy";
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
import { Update } from "./commands/update";
import { Uninstall } from "./commands/uninstall";
import { New } from "./commands/new";
import { Help } from "./commands/help";
import { Version } from "./commands/version";

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

function route(command: string, args: string[]): ReactNode {
  switch (command) {
    case "new":
      return <New args={args} />;
    case "doctor":
      return <Doctor />;
    case "node":
      return <Node args={args} />;
    case "up":
      return <Up args={args} />;
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
    default:
      return <Help unknown={command !== "help" && !command.startsWith("-")} command={command} />;
  }
}
