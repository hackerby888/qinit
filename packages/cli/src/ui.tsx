// Shared terminal-UI kit (no external deps — bundles clean into the `bun --compile` binary).
// Primitives: gradient wordmark, banner/header, panels, status lines, key-value, badges,
// spinner, and a phase step-list. Pure ink <Box>/<Text> + ANSI hex colors via chalk.
import { useEffect, useState } from "react";
import { Box, Text } from "ink";

export type Theme = { gradFrom: string; gradTo: string; brand: string; accent: string; ok: string; err: string; warn: string; info: string; mute: string };

// Color variants. ok/err/warn stay semantic (green/red/amber); brand/accent/info/gradient carry the "look".
// Pick with `qinit theme`; the choice persists and every command's UI follows it.
export const THEMES: Record<string, Theme> = {
  default: { gradFrom: "#7c5cff", gradTo: "#22d3ee", brand: "#7c5cff", accent: "#f472b6", ok: "#22c55e", err: "#ef4444", warn: "#f59e0b", info: "#22d3ee", mute: "gray" },
  emerald: { gradFrom: "#10b981", gradTo: "#a7f3d0", brand: "#10b981", accent: "#f59e0b", ok: "#22c55e", err: "#ef4444", warn: "#f59e0b", info: "#2dd4bf", mute: "gray" },
  ocean:   { gradFrom: "#3b82f6", gradTo: "#22d3ee", brand: "#3b82f6", accent: "#38bdf8", ok: "#22c55e", err: "#ef4444", warn: "#f59e0b", info: "#38bdf8", mute: "gray" },
  rose:    { gradFrom: "#f43f5e", gradTo: "#fb7185", brand: "#f43f5e", accent: "#a78bfa", ok: "#22c55e", err: "#ef4444", warn: "#f59e0b", info: "#fb7185", mute: "gray" },
  amber:   { gradFrom: "#f59e0b", gradTo: "#fde047", brand: "#f59e0b", accent: "#fb7185", ok: "#22c55e", err: "#ef4444", warn: "#f97316", info: "#fbbf24", mute: "gray" },
  mono:    { gradFrom: "#64748b", gradTo: "#cbd5e1", brand: "#94a3b8", accent: "#cbd5e1", ok: "#22c55e", err: "#ef4444", warn: "#f59e0b", info: "#94a3b8", mute: "gray" },
};
export const THEME_NAMES = Object.keys(THEMES);

// Mutable so a saved choice applied at startup (applyTheme) is seen by every component that reads `theme.*`.
export const theme: Theme = { ...THEMES.default };
export function applyTheme(name?: string): string {
  const key = name && THEMES[name] ? name : "default";
  Object.assign(theme, THEMES[key]);
  return key;
}

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

// WHITE text on a per-char gradient background — the standard highlight (table header, selected picker row).
// Global rule: text on a gradient background is always white.
export function GradLine({ text, from = theme.gradFrom, to = theme.gradTo, bold = true }:
  { text: string; from?: string; to?: string; bold?: boolean }) {
  const n = text.length;
  return (
    <Text bold={bold}>
      {[...text].map((ch, i) => <Text key={i} backgroundColor={lerp(from, to, n < 2 ? 0 : i / (n - 1))} color="#ffffff">{ch}</Text>)}
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
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1} alignSelf="flex-start">
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
      <Box borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" alignSelf="flex-start">{children}</Box>
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
      {detail ? <Text dimColor>{truncMid(detail, Math.max(12, termCols() - pad - 8))}</Text> : null}
    </Text>
  );
}

// ---- key/value table -------------------------------------------------------
// full=true → never truncate values (for copy-pasteable ids / txids / hashes).
export function KV({ rows, full }: { rows: [string, string][]; full?: boolean }) {
  const w = Math.max(0, ...rows.map(([k]) => k.length));
  return (
    <Box flexDirection="column">
      {rows.map(([k, v], i) => (
        <Text key={i}><Text color={theme.info}>{k.padEnd(w)}</Text>  <Text wrap={full ? "wrap" : undefined}>{full ? v : truncMid(v, Math.max(12, termCols() - w - 8))}</Text></Text>
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

// ---- progress bar + timings ------------------------------------------------
// Gradient progress bar with gradient bracket caps — fill runs theme.gradFrom -> theme.gradTo.
export function Bar({ pct, width = 22 }: { pct: number; width?: number }) {
  const p = Math.max(0, Math.min(1, pct || 0));
  const fill = Math.round(p * width);
  const cells = Array.from({ length: width }, (_, i) =>
    i < fill
      ? <Text key={i} color={lerp(theme.gradFrom, theme.gradTo, width < 2 ? 0 : i / (width - 1))}>█</Text>
      : <Text key={i} dimColor>░</Text>);
  return <Text><Text color={theme.gradFrom}>▕</Text>{cells}<Text color={theme.gradTo}>▏</Text> <Text dimColor>{Math.round(p * 100)}%</Text></Text>;
}
export const fmtMs = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// Keep one line inside the terminal so it never wraps past a panel border.
// truncEnd keeps the head (errors/labels); truncMid keeps head+tail (paths/digests).
export const termCols = () => Math.max(40, process.stdout.columns || 80);
export const truncEnd = (s: string, max: number) => (s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…");
export const truncMid = (s: string, max: number) => {
  if (s.length <= max) return s;
  const keep = Math.max(2, max - 1), head = Math.ceil(keep / 2), tail = keep - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
};

// Rich pipeline row: glyph + fixed-width label + live detail OR progress bar + elapsed.
export function StepRow({ state, label, detail, pct, elapsedMs }:
  { state: StepState; label: string; detail?: string; pct?: number; elapsedMs?: number }) {
  const f = useFrame();
  const glyph =
    state === "ok" ? <Text color={theme.ok}>✓</Text> :
    state === "fail" ? <Text color={theme.err}>✗</Text> :
    state === "active" ? <Text color={theme.info}>{FRAMES[f % FRAMES.length]}</Text> :
    <Text dimColor>◌</Text>;
  return (
    <Text>
      {glyph} <Text bold={state !== "pending"} color={state === "pending" ? theme.mute : undefined}>{label.padEnd(14)}</Text>
      {pct != null && state === "active" ? <Bar pct={pct} /> : detail ? <Text dimColor>{truncEnd(detail, Math.max(12, termCols() - 24))}</Text> : null}
      {state === "ok" && elapsedMs ? <Text dimColor>{`  ${fmtMs(elapsedMs)}`}</Text> : null}
    </Text>
  );
}

// ---- table -----------------------------------------------------------------
// Auto-width columns from content (capped to the terminal); per-column align/color/dim/max; truncMid cells.
// `selected` (row index) inverse-highlights a row — for interactive lists (debug). gap = 2 spaces.
export interface Column { header: string; align?: "left" | "right"; color?: string; dim?: boolean; max?: number }
export function Table({ columns, rows, selected, rowColor }:
  { columns: Column[]; rows: string[][]; selected?: number; rowColor?: (i: number) => string | undefined }) {
  const gap = 2;
  const widths = columns.map((c, i) => {
    const w = Math.max(c.header.length, 0, ...rows.map((r) => (r[i] ?? "").length));
    return c.max ? Math.min(w, c.max) : w;
  });
  // shrink the widest columns until the row fits the terminal
  let over = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, columns.length - 1) - termCols();
  while (over > 0) {
    let mi = 0; for (let i = 1; i < widths.length; i++) if (widths[i] > widths[mi]) mi = i;
    if (widths[mi] <= 6) break;
    widths[mi]--; over--;
  }
  const cell = (s: string, i: number) => {
    const v = truncMid(s ?? "", widths[i]);
    return columns[i].align === "right" ? v.padStart(widths[i]) : v.padEnd(widths[i]);
  };
  const sp = " ".repeat(gap);
  const rowText = (cells: string[]) => columns.map((c, i) => cell(cells[i] ?? "", i) + (i < columns.length - 1 ? sp : "")).join("");
  // header: one continuous gradient-background band (white bold text) across the full table width.
  const Header = () => <Box><GradLine text={rowText(columns.map((c) => c.header))} /></Box>;
  const Row = ({ r, ri }: { r: string[]; ri: number }) => {
    if (ri === selected) return <Box><GradLine text={rowText(r)} /></Box>;   // selected -> gradient bg, white text
    const rc = rowColor?.(ri);
    return (
      <Box>
        {columns.map((c, i) => (
          <Text key={i} dimColor={c.dim && !rc} color={rc ?? c.color}>
            {cell(r[i] ?? "", i)}{i < columns.length - 1 ? sp : ""}
          </Text>
        ))}
      </Box>
    );
  };
  return (
    <Box flexDirection="column">
      <Header />
      {rows.map((r, ri) => <Row key={ri} r={r} ri={ri} />)}
    </Box>
  );
}
