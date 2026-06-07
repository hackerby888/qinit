import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { VERSION } from "../version";
import { Banner, theme } from "../ui";

const COMMANDS: [string, string][] = [
  ["new", "scaffold a project: new <name> --template counter|hashmap|asset|intercontract"],
  ["doctor", "check toolchain (wasi-sdk, node, core headers, qubic lib)"],
  ["sync", "fetch/build the core-header snapshot into the cache"],
  ["node", "run / status / stop / get the dev node (run --bin <path>)"],
  ["up", "one command: sync headers + get node + run (reuses a ticking node)"],
  ["dev", "watch the contract -> auto build+deploy on save (q to quit)"],
  ["build", "compile a contract .h -> wasm (+ K12 hash, IDL)"],
  ["gen", "generate a typed TS client from the contract IDL"],
  ["deploy", "build + chunk-upload + deploy a contract to a node"],
  ["ls", "list contracts deployed on the node (slot / name / state / hash)"],
  ["debug", "live contract-call inspector — input/output, state diff, host-calls, traps"],
  ["test", "deploy to an ephemeral node + run bun tests against it"],
  ["call", "call a contract function (--fn) or invoke a procedure (--proc)"],
  ["smoke", "run the standalone-binary crypto smoke test"],
  ["version", "print version"],
  ["help", "show this help"],
];

export function Help({ unknown, command }: { unknown?: boolean; command?: string }) {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  return (
    <Box flexDirection="column">
      {unknown && <Box marginBottom={1}><Text><Text color={theme.warn}>✗ unknown command:</Text> <Text bold>{command}</Text></Text></Box>}
      <Banner version={VERSION} tagline="Framework for Qubic dynamic contracts" />
      <Text dimColor>usage: <Text color={theme.info}>qinit</Text> &lt;command&gt; [args]</Text>
      <Box marginTop={1} flexDirection="column">
        {COMMANDS.map(([name, desc]) => (
          <Text key={name}>
            {"  "}<Text bold color={theme.accent}>{name.padEnd(10)}</Text>
            <Text dimColor>{desc}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
