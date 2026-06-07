import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { VERSION } from "../version";
import { Banner, theme } from "../ui";

// Grouped by workflow stage so the list reads top-to-bottom as you'd actually use qinit.
const GROUPS: { title: string; items: [string, string][] }[] = [
  { title: "setup & node", items: [
    ["up", "one command: sync headers + get node + run (reuses a ticking node)"],
    ["doctor", "check toolchain (wasi-sdk, node.js, core headers, qubic lib)"],
    ["node", "run / status / stop / get the dev node (run --bin <path>)"],
    ["clean", "remove all qinit cache (node, headers, wasi-sdk, tools); --dry-run to preview"],
    ["self-update", "update qinit to the newest release; --force / --dry-run"],
    ["uninstall", "remove qinit + its cache (--yes to confirm, --keep-cache)"],
  ]},
  { title: "develop", items: [
    ["new", "scaffold a project: new <name> --template counter|hashmap|asset|intercontract"],
    ["dev", "watch the contract -> auto build+deploy on save (q to quit)"],
    ["build", "compile a contract .h -> wasm (+ K12 hash, IDL)"],
    ["gen", "generate a typed TS client from the contract IDL"],
  ]},
  { title: "deploy & interact", items: [
    ["deploy", "build + chunk-upload + deploy a contract to a node"],
    ["call", "call a fn (--fn) / proc (--proc); --args '<json>' input, --trace post-call view"],
    ["seed", "pick a funded signer seed (saved + auto-used everywhere); --show / --clear"],
    ["ls", "list contracts deployed on the node (slot / name / state / hash)"],
    ["state", "decode + print a deployed contract's current state (fields + containers)"],
    ["debug", "live contract-call inspector — input/output, state diff, host-calls, traps"],
    ["test", "deploy to an ephemeral node + run bun tests against it"],
  ]},
  { title: "misc", items: [
    ["cheat-sheet", "one-screen guide: setup → contract → deploy → call (+ input/output formats)"],
    ["smoke", "run the standalone-binary crypto smoke test"],
    ["version", "print version"],
    ["help", "show this help"],
  ]},
];

export function Help({ unknown, command }: { unknown?: boolean; command?: string }) {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  return (
    <Box flexDirection="column">
      {unknown && <Box marginBottom={1}><Text><Text color={theme.warn}>✗ unknown command:</Text> <Text bold>{command}</Text></Text></Box>}
      <Banner version={VERSION} tagline="Framework for Qubic dynamic contracts" />
      <Text dimColor>usage: <Text color={theme.info}>qinit</Text> &lt;command&gt; [args]</Text>
      {(() => {
        const w = Math.max(...GROUPS.flatMap((g) => g.items.map(([n]) => n.length))) + 2;   // align descriptions across all groups
        return GROUPS.map((g) => (
          <Box key={g.title} marginTop={1} flexDirection="column">
            <Text bold color={theme.brand}>{g.title}</Text>
            {g.items.map(([name, desc]) => (
              <Text key={name}>
                {"  "}<Text bold color={theme.accent}>{name.padEnd(w)}</Text>
                <Text dimColor>{desc}</Text>
              </Text>
            ))}
          </Box>
        ));
      })()}
    </Box>
  );
}
