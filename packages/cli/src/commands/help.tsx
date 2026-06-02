import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { VERSION } from "../version";

const COMMANDS: [string, string][] = [
  ["new", "scaffold a new contract project (contracts/, qinit.json)"],
  ["doctor", "check toolchain (clang-18, node, core headers, qubic lib)"],
  ["build", "compile a contract .h -> .so (+ hash, unresolved-symbol report)"],
  ["deploy", "build + chunk-upload + deploy a contract to a node"],
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
      {unknown && <Text color="yellow">unknown command: {command}</Text>}
      <Text>
        <Text bold color="cyan">qinit</Text> {VERSION} — Anchor-like framework for Qubic dynamic contracts
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>usage: qinit &lt;command&gt; [args]</Text>
        <Box marginTop={1} flexDirection="column">
          {COMMANDS.map(([name, desc]) => (
            <Text key={name}>
              {"  "}<Text color="green">{name.padEnd(10)}</Text>
              <Text dimColor>{desc}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
