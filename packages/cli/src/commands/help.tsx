import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { VERSION } from "../version";
import { Banner, theme } from "../ui";

// Grouped by workflow stage so the list reads top-to-bottom as you'd actually use qinit.
// Each command may carry `ex`: extra note/example lines shown indented right below it.
type Cmd = { name: string; desc: string; ex?: string[] };
const GROUPS: { title: string; items: Cmd[] }[] = [
  { title: "setup & node", items: [
    { name: "up", desc: "one command: sync headers + get node + run (reuses a ticking node)" },
    { name: "doctor", desc: "check toolchain (wasi-sdk, node.js, core headers, qubic lib)" },
    { name: "node", desc: "run / status / stop / get the dev node (run --bin <path>)" },
    { name: "tick", desc: "show epoch tick window; tick advance <n> / advance-to-last [gap] (testnet)" },
    { name: "epoch", desc: "show epoch info; epoch advance -> next epoch via seamless transition (testnet)" },
    { name: "clean", desc: "remove all qinit cache (node, headers, wasi-sdk, tools); --dry-run to preview" },
    { name: "self-update", desc: "update qinit to the newest release; --force / --dry-run" },
    { name: "uninstall", desc: "remove qinit + its cache (--yes to confirm, --keep-cache)" },
  ]},
  { title: "develop", items: [
    { name: "new", desc: "scaffold a project: new <name> --template counter|hashmap|asset|intercontract" },
    { name: "dev", desc: "watch the contract -> auto build+deploy on save (q to quit)" },
    { name: "build", desc: "compile a contract .h -> wasm (+ K12 hash, IDL)" },
    { name: "gen", desc: "generate a typed TS client from the contract IDL" },
  ]},
  { title: "deploy & interact", items: [
    { name: "deploy", desc: "build + chunk-upload + deploy a contract to a node" },
    { name: "call", desc: "call a fn (--fn) / proc (--proc); --in \"<format>\" input, --trace post-call view", ex: [
      `qinit call --proc Mytoken 1 --in "<ID>id, 100uint64"`,
      `qinit call --fn   Mytoken 1 --in "<ID>id" --out uint64`,
      "--proc signs a tx + waits for it to process · --fn is a read-only query",
    ]},
    { name: "seed", desc: "pick a funded signer seed (saved + auto-used everywhere); --show / --clear" },
    { name: "ls", desc: "list contracts deployed on the node (slot / name / state / hash)" },
    { name: "state", desc: "decode + print a deployed contract's current state (fields + containers)" },
    { name: "debug", desc: "live contract-call inspector — input/output, state diff, host-calls, traps" },
    { name: "test", desc: "deploy to an ephemeral node + run bun tests against it" },
  ]},
  { title: "misc", items: [
    { name: "cheat-sheet", desc: "one-screen guide: setup → contract → deploy → call (+ input/output formats)" },
    { name: "smoke", desc: "run the standalone-binary crypto smoke test" },
    { name: "version", desc: "print version" },
    { name: "help", desc: "show this help" },
  ]},
];

export function Help({ unknown, command }: { unknown?: boolean; command?: string }) {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  const w = Math.max(...GROUPS.flatMap((g) => g.items.map((c) => c.name.length))) + 2;   // align descriptions across all groups
  const pad = "  " + " ".repeat(w);   // indent for the ex/note lines (aligns under the description)
  return (
    <Box flexDirection="column">
      {unknown && <Box marginBottom={1}><Text><Text color={theme.warn}>✗ unknown command:</Text> <Text bold>{command}</Text></Text></Box>}
      <Banner version={VERSION} tagline="Framework for Qubic dynamic contracts" />
      <Text dimColor>usage: <Text color={theme.info}>qinit</Text> &lt;command&gt; [args]</Text>
      {GROUPS.map((g) => (
        <Box key={g.title} marginTop={1} flexDirection="column">
          <Text bold color={theme.brand}>{g.title}</Text>
          {g.items.map((c) => (
            <Box key={c.name} flexDirection="column">
              <Text>{"  "}<Text bold color={theme.accent}>{c.name.padEnd(w)}</Text><Text dimColor>{c.desc}</Text></Text>
              {c.ex?.map((line, i) => (
                <Text key={i}>{pad}{line.startsWith("qinit ") ? <Text color={theme.info}>{line}</Text> : <Text dimColor>{line}</Text>}</Text>
              ))}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
