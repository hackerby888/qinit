// Shared terminal-UI kit (no external deps — bundles clean into the `bun --compile` binary).
// Primitives: gradient wordmark, banner/header, panels, status lines, key-value, badges,
// spinner, and a phase step-list. Pure ink <Box>/<Text> + ANSI hex colors via chalk.
import { useEffect, useState } from "react";
import { Box, Text } from "ink";

export const theme = {
  gradFrom: "#7c5cff", // violet
  gradTo: "#22d3ee",   // cyan
  brand: "#7c5cff",
  accent: "#f472b6",   // pink
  ok: "#22c55e",
  err: "#ef4444",
  warn: "#f59e0b",
  info: "#22d3ee",
  mute: "gray" as const,
};

// ---- color helpers ---------------------------------------------------------
function hx(c: string): [number, number, number] {
  const h = c.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lerp(a: string, b: string, t: number): string {
  const x = hx(a), y = hx(b);
  const m = (i: number) => Math.round(x[i] + (y[i] - x[i]) * t).toString(16).padStart(2, "0");
  return `#${m(0)}${m(1)}${m(2)}`;
}

// Per-character gradient text.
export function Grad({ text, from = theme.gradFrom, to = theme.gradTo, bold = true }:
  { text: string; from?: string; to?: string; bold?: boolean }) {
  const n = text.length;
  return (
    <Text bold={bold}>
      {[...text].map((ch, i) => <Text key={i} color={lerp(from, to, n < 2 ? 0 : i / (n - 1))}>{ch}</Text>)}
    </Text>
  );
}

// Gradient horizontal rule.
export function Rule({ width = 50 }: { width?: number }) {
  return <Grad text={"─".repeat(width)} bold={false} />;
}

// ---- spinner ---------------------------------------------------------------
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function useFrame(interval = 80): number {
  const [f, setF] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setF((x) => x + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  return f;
}
export function Spinner({ label, color = theme.info }: { label: string; color?: string }) {
  const f = useFrame();
  return <Text><Text color={color}>{FRAMES[f % FRAMES.length]}</Text> {label}<Text dimColor>…</Text></Text>;
}

// ---- chips / badges --------------------------------------------------------
export function Badge({ text, color = theme.brand }: { text: string; color?: string }) {
  return <Text backgroundColor={color} color="#000000" bold>{` ${text} `}</Text>;
}

// ---- header / banner -------------------------------------------------------
// Compact per-command header:  qinit ▸ deploy
export function Header({ cmd }: { cmd: string }) {
  return (
    <Box marginBottom={1}>
      <Text><Grad text="qinit" /><Text dimColor>{"  ▸  "}</Text><Text bold color={theme.accent}>{cmd}</Text></Text>
    </Box>
  );
}

// Full banner for help/version.
export function Banner({ version, tagline }: { version: string; tagline: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1}>
        <Text>
          <Text color={theme.accent}>◆ </Text>
          <Grad text="qinit" />
          <Text dimColor>{"   "}</Text>
          <Badge text={`v${version}`} color={theme.info} />
          <Text dimColor>{`   ${tagline}`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

// ---- panel -----------------------------------------------------------------
export function Panel({ title, color = theme.info, children }:
  { title?: string; color?: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column">
      {title && <Box><Badge text={title} color={color} /></Box>}
      <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column">{children}</Box>
    </Box>
  );
}

// ---- status line -----------------------------------------------------------
// ok: true=✓green  false=✗red  null/undefined=•cyan (neutral)
export function Status({ ok, label, detail, pad = 22 }:
  { ok?: boolean | null; label: string; detail?: string; pad?: number }) {
  const glyph = ok === true ? "✓" : ok === false ? "✗" : "•";
  const col = ok === true ? theme.ok : ok === false ? theme.err : theme.info;
  return (
    <Text>
      <Text color={col}>{glyph}</Text> <Text bold>{label.padEnd(pad)}</Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
    </Text>
  );
}

// ---- key/value table -------------------------------------------------------
export function KV({ rows }: { rows: [string, string][] }) {
  const w = Math.max(0, ...rows.map(([k]) => k.length));
  return (
    <Box flexDirection="column">
      {rows.map(([k, v], i) => (
        <Text key={i}><Text color={theme.info}>{k.padEnd(w)}</Text>  <Text>{v}</Text></Text>
      ))}
    </Box>
  );
}

// ---- step list (deploy phases) ---------------------------------------------
export type StepState = "pending" | "active" | "ok" | "fail";
export function Step({ state, label, detail }: { state: StepState; label: string; detail?: string }) {
  const f = useFrame();
  const glyph =
    state === "ok" ? <Text color={theme.ok}>✓</Text> :
    state === "fail" ? <Text color={theme.err}>✗</Text> :
    state === "active" ? <Text color={theme.info}>{FRAMES[f % FRAMES.length]}</Text> :
    <Text dimColor>◌</Text>;
  const labelColor = state === "pending" ? theme.mute : undefined;
  return (
    <Text>
      {glyph} <Text bold={state !== "pending"} color={labelColor}>{label}</Text>
      {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
    </Text>
  );
}
