// Command router. One-shot: each command renders, does its work, then exits.
import { Doctor } from "./commands/doctor";
import { Smoke } from "./commands/smoke";
import { Build } from "./commands/build";
import { Deploy } from "./commands/deploy";
import { Call } from "./commands/call";
import { New } from "./commands/new";
import { Help } from "./commands/help";
import { Version } from "./commands/version";

export function App({ command, args }: { command: string; args: string[] }) {
  switch (command) {
    case "new":
      return <New args={args} />;
    case "doctor":
      return <Doctor />;
    case "smoke":
      return <Smoke />;
    case "build":
      return <Build args={args} />;
    case "deploy":
      return <Deploy args={args} />;
    case "call":
      return <Call args={args} />;
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
