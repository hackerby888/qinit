import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { savedCompiler, setSavedCompiler, COMPILERS, type Compiler } from "../config";
import { Header, GradLine, theme } from "../ui";
import { parseArgs } from "../args";

// The compiler is the backend every build command (build / deploy / dev / test) turns a .h into wasm with.
const DESC: Record<Compiler, string> = {
  native: "clang / wasi-sdk (bit-exact; needs the toolchain installed)",
  local: "in-process TS compiler (no toolchain; instant)",
};

export function CompilerCmd({ args }: { args: string[] }) {
  const parsed = parseArgs(args, { booleans: ["show"] });
  const o = {
    name: parsed.pos[0],
    show: parsed.has("show"),
  };
  const { exit } = useApp();
  const cur: Compiler = savedCompiler() ?? "native";
  const [i, setI] = useState(Math.max(0, COMPILERS.indexOf(cur)));
  // Mirror selection in a ref so rapid arrow/Enter input uses the latest choice.
  const sel = useRef(i);
  const move = (d: number): void => {
    sel.current = (sel.current + d + COMPILERS.length) % COMPILERS.length;
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
      if (o.name !== "native" && o.name !== "local") {
        add(`✗ unknown compiler '${o.name}' — pick: ${COMPILERS.join(", ")}`);
        return;
      }
      setSavedCompiler(o.name);
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
        const name = COMPILERS[sel.current];
        setSavedCompiler(name);
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
            {COMPILERS.map((name, idx) => {
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
