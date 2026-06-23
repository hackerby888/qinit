import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { savedMode, setSavedMode, NODE_MODES, type NodeMode } from "../config";
import { Header, GradLine, theme } from "../ui";

// qinit mode                          -> interactive picker; ↵ saves, q cancels
// qinit mode <realnode|virtualnode>   -> set directly
// qinit mode --show                   -> print the active mode
function parse(args: string[]): { name?: string; show?: boolean } {
  const o: { name?: string; show?: boolean } = {};
  for (const a of args) {
    if (a === "--show") {
      o.show = true;
    } else if (!a.startsWith("--")) {
      o.name = a;
    }
  }
  return o;
}

// What each mode means, shown next to the choice in the picker. The mode is the backend every node command
// (node run / deploy / call / state / dev / test) runs against.
const DESC: Record<NodeMode, string> = {
  realnode: "qubic node binary (fetched + run by `qinit node run`)",
  virtualnode: "in-process TS engine (no binary; instant, in-memory)",
};

export function ModeCmd({ args }: { args: string[] }) {
  const o = parse(args);
  const { exit } = useApp();
  const cur: NodeMode = savedMode() ?? "realnode";
  const [i, setI] = useState(Math.max(0, NODE_MODES.indexOf(cur)));
  const [msg, setMsg] = useState<string[]>([]);
  const [phase, setPhase] = useState<"pick" | "done">(o.name || o.show ? "done" : "pick");
  const add = (s: string) => setMsg((m) => [...m, s]);

  useEffect(() => {
    if (o.show) {
      add(`active mode: ${cur}`);
      return;
    }
    if (o.name) {
      if (o.name !== "realnode" && o.name !== "virtualnode") {
        add(`✗ unknown mode '${o.name}' — pick: ${NODE_MODES.join(", ")}`);
        return;
      }
      setSavedMode(o.name);
      add(`✓ mode set: ${o.name}`);
    }
  }, []);

  useEffect(() => {
    if (phase === "done") {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
  }, [phase]);

  useInput((input, key) => {
    if (phase !== "pick") {
      return;
    }
    if (input === "q" || key.escape) {
      exit();
    } else if (key.upArrow) {
      setI((p) => (p - 1 + NODE_MODES.length) % NODE_MODES.length);
    } else if (key.downArrow) {
      setI((p) => (p + 1) % NODE_MODES.length);
    } else if (key.return) {
      const name = NODE_MODES[i];
      setSavedMode(name);
      add(`✓ mode saved: ${name}`);
      setPhase("done");
    }
  }, { isActive: Boolean(process.stdin.isTTY) });

  return (
    <Box flexDirection="column">
      <Header cmd="mode" />
      {phase === "done" && msg.map((m, k) => <Text key={k} color={m.startsWith("✗") ? theme.err : theme.ok}>{m}</Text>)}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ save · q cancel</Text>
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {NODE_MODES.map((name, idx) => {
              const sel = idx === i;
              return (
                <Text key={name}>
                  {sel ? <GradLine text={"▸ " + name.padEnd(12)} /> : <Text>{"  "}<Text color={theme.brand}>{name.padEnd(12)}</Text></Text>}
                  <Text dimColor> {DESC[name]}</Text>
                  {name === cur ? <Text color={theme.ok}> ✓ current</Text> : null}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
