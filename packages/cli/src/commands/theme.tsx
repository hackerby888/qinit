import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { savedTheme, setSavedTheme } from "../config";
import { Header, Grad, GradLine, THEMES, THEME_NAMES, applyTheme, theme } from "../ui";

// qinit theme            -> interactive picker (live preview); ↵ saves, q cancels
// qinit theme <name>     -> set directly
// qinit theme --show     -> print the active theme
function parse(args: string[]): { name?: string; show?: boolean } {
  const o: { name?: string; show?: boolean } = {};
  for (const a of args) { if (a === "--show") o.show = true; else if (!a.startsWith("--")) o.name = a; }
  return o;
}

// a row of color blocks for one variant — gradient + brand/accent/info + semantic
function Swatch({ name }: { name: string }) {
  const t = THEMES[name];
  const cols = [t.gradFrom, t.gradTo, t.brand, t.accent, t.info, t.ok, t.warn, t.err];
  return <Text>{cols.map((c, i) => <Text key={i} color={c}>█</Text>)}</Text>;
}

export function ThemeCmd({ args }: { args: string[] }) {
  const o = parse(args);
  const { exit } = useApp();
  const cur = savedTheme() && THEMES[savedTheme()!] ? savedTheme()! : "default";
  const [i, setI] = useState(Math.max(0, THEME_NAMES.indexOf(cur)));
  const [msg, setMsg] = useState<string[]>([]);
  const [phase, setPhase] = useState<"pick" | "done">(o.name || o.show ? "done" : "pick");
  const add = (s: string) => setMsg((m) => [...m, s]);

  useEffect(() => {
    if (o.show) { add(`active theme: ${cur}`); return; }
    if (o.name) {
      if (!THEMES[o.name]) { add(`✗ unknown theme '${o.name}' — pick: ${THEME_NAMES.join(", ")}`); return; }
      setSavedTheme(o.name); applyTheme(o.name); add(`✓ theme set: ${o.name}`);
    }
  }, []);
  // live preview: applying the highlighted variant recolors the header as you move
  useEffect(() => { if (phase === "pick") applyTheme(THEME_NAMES[i]); }, [i, phase]);
  useEffect(() => { if (phase === "done") { const t = setTimeout(() => exit(), 30); return () => clearTimeout(t); } }, [phase]);

  useInput((input, key) => {
    if (phase !== "pick") return;
    if (input === "q" || key.escape) { applyTheme(cur); exit(); }            // cancel -> restore saved
    else if (key.upArrow) setI((p) => (p - 1 + THEME_NAMES.length) % THEME_NAMES.length);
    else if (key.downArrow) setI((p) => (p + 1) % THEME_NAMES.length);
    else if (key.return) { const name = THEME_NAMES[i]; setSavedTheme(name); applyTheme(name); add(`✓ theme saved: ${name}`); setPhase("done"); }
  }, { isActive: Boolean(process.stdin.isTTY) });

  return (
    <Box flexDirection="column">
      <Header cmd="theme" />
      {phase === "done" && msg.map((m, k) => <Text key={k} color={m.startsWith("✗") ? theme.err : theme.ok}>{m}</Text>)}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Box marginBottom={1}><Grad text="preview:  qinit" /><Text dimColor>  ▸  theme</Text></Box>
          <Text dimColor>↑/↓ select · ↵ save · q cancel</Text>
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {THEME_NAMES.map((name, idx) => {
              const sel = idx === i;
              return <Text key={name}>{sel ? <GradLine text={"▸ " + name.padEnd(9)} /> : <Text>{"  "}<Text color={theme.brand}>{name.padEnd(9)}</Text></Text>} <Swatch name={name} />{name === cur ? <Text color={theme.ok}> ✓ current</Text> : null}</Text>;
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
