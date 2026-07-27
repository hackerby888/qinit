import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  COMPILER_BACKENDS,
  savedCompilerBackend,
  setSavedCompilerBackend,
  type CompilerBackend,
} from "../config";
import { Header, GradLine, theme } from "../ui";
import { parseCommandArgs } from "../args";

const DESC: Record<CompilerBackend, string> = {
  clang: "clang / wasi-sdk (bit-exact; needs the toolchain installed)",
  typescript: "in-process TypeScript compiler (no toolchain; instant)",
};

export function CompilerCmd({ args }: { args: string[] }) {
  const parsed = parseCommandArgs("compiler", args);
  const o = {
    name: parsed.pos[0],
    show: parsed.has("show"),
  };
  const { exit } = useApp();
  const cur: CompilerBackend = savedCompilerBackend() ?? "clang";
  const [i, setI] = useState(Math.max(0, COMPILER_BACKENDS.indexOf(cur)));
  // Mirror selection in a ref so rapid arrow/Enter input uses the latest choice.
  const sel = useRef(i);
  const move = (d: number): void => {
    sel.current = (sel.current + d + COMPILER_BACKENDS.length) % COMPILER_BACKENDS.length;
    setI(sel.current);
  };
  const [msg, setMsg] = useState<string[]>([]);
  const [phase, setPhase] = useState<"pick" | "done">(o.name || o.show ? "done" : "pick");
  const add = (s: string) => setMsg((m) => [...m, s]);

  useEffect(() => {
    if (o.show) {
      add(`active compiler: ${cur}`);
      return;
    }
    if (o.name) {
      if (o.name !== "clang" && o.name !== "typescript") {
        add(`✗ unknown compiler '${o.name}' — pick: ${COMPILER_BACKENDS.join(", ")}`);
        return;
      }
      setSavedCompilerBackend(o.name);
      add(`✓ compiler set: ${o.name}`);
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
        const name = COMPILER_BACKENDS[sel.current];
        setSavedCompilerBackend(name);
        add(`✓ compiler saved: ${name}`);
        setPhase("done");
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  return (
    <Box flexDirection="column">
      <Header cmd="compiler" />
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
            {COMPILER_BACKENDS.map((name, idx) => {
              const isSel = idx === i;
              return (
                <Text key={name}>
                  {isSel ? (
                    <GradLine text={"▸ " + name.padEnd(8)} />
                  ) : (
                    <Text>
                      {"  "}
                      <Text color={theme.brand}>{name.padEnd(8)}</Text>
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
