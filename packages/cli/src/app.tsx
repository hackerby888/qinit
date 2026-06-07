// Command router. One-shot: each command renders, does its work, then exits.
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
import { Update } from "./commands/update";
import { Uninstall } from "./commands/uninstall";
import { New } from "./commands/new";
import { Help } from "./commands/help";
import { Version } from "./commands/version";

export function App({ command, args }: { command: string; args: string[] }) {
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
