import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  NODE_BACKENDS,
  savedNodeBackend,
  setSavedNodeBackend,
  type NodeBackend,
} from "../config";
import { Header, GradLine, theme } from "../ui";
import { parseCommandArgs } from "../args";

const DESC: Record<NodeBackend, string> = {
  core: "core-lite node reached through RPC (`qinit node run` can launch one)",
  simulator: "in-process Qinit simulator (no node binary)",
};

export function NodeBackendCmd({ args }: { args: string[] }) {
  const parsed = parseCommandArgs("node-backend", args);
  const o = {
    name: parsed.pos[0],
    show: parsed.has("show"),
  };
  const { exit } = useApp();
  const cur: NodeBackend = savedNodeBackend() ?? "core";
  const [i, setI] = useState(Math.max(0, NODE_BACKENDS.indexOf(cur)));
  // Mirror selection in a ref so rapid arrow/Enter input uses the latest choice.
  const sel = useRef(i);
  const move = (d: number): void => {
    sel.current = (sel.current + d + NODE_BACKENDS.length) % NODE_BACKENDS.length;
    setI(sel.current);
  };
  const [msg, setMsg] = useState<string[]>([]);
  const [phase, setPhase] = useState<"pick" | "done">(o.name || o.show ? "done" : "pick");
  const add = (s: string) => setMsg((m) => [...m, s]);

  useEffect(() => {
    if (o.show) {
      add(`active node backend: ${cur}`);
      return;
    }
    if (o.name) {
      if (o.name !== "core" && o.name !== "simulator") {
        add(`✗ unknown node backend '${o.name}' — pick: ${NODE_BACKENDS.join(", ")}`);
        return;
      }
      setSavedNodeBackend(o.name);
      add(`✓ node backend set: ${o.name}`);
    }
  }, []);

  useEffect(() => {
    if (phase === "done") {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
  }, [phase]);

  useInput(
    (input, key) => {
      if (phase !== "pick") {
        return;
      }
      if (input === "q" || key.escape) {
        exit();
      } else if (key.upArrow) {
        move(-1);
      } else if (key.downArrow) {
        move(1);
      } else if (key.return) {
        const name = NODE_BACKENDS[sel.current];
        setSavedNodeBackend(name);
        add(`✓ node backend saved: ${name}`);
        setPhase("done");
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  return (
    <Box flexDirection="column">
      <Header cmd="node-backend" />
      {phase === "done" &&
        msg.map((m, k) => (
          <Text key={k} color={m.startsWith("✗") ? theme.err : theme.ok}>
            {m}
          </Text>
        ))}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ save · q cancel</Text>
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {NODE_BACKENDS.map((name, idx) => {
              const sel = idx === i;
              return (
                <Text key={name}>
                  {sel ? (
                    <GradLine text={"▸ " + name.padEnd(12)} />
                  ) : (
                    <Text>
                      {"  "}
                      <Text color={theme.brand}>{name.padEnd(12)}</Text>
                    </Text>
                  )}
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
