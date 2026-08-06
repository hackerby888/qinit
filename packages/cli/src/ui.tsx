import { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { output } from "./args";

export type Theme = {
  gradFrom: string;
  gradTo: string;
  brand: string;
  accent: string;
  ok: string;
  err: string;
  warn: string;
  info: string;
  mute: string;
};

export const THEMES: Record<string, Theme> = {
  default: {
    gradFrom: "#7c5cff",
    gradTo: "#22d3ee",
    brand: "#7c5cff",
    accent: "#a78bfa",
    ok: "#22c55e",
    err: "#ef4444",
    warn: "#f59e0b",
    info: "#38bdf8",
    mute: "gray",
  },
  emerald: {
    gradFrom: "#10b981",
    gradTo: "#6ee7b7",
    brand: "#10b981",
    accent: "#34d399",
    ok: "#22c55e",
    err: "#ef4444",
    warn: "#f59e0b",
    info: "#2dd4bf",
    mute: "gray",
  },
  ocean: {
    gradFrom: "#3b82f6",
    gradTo: "#22d3ee",
    brand: "#3b82f6",
    accent: "#60a5fa",
    ok: "#22c55e",
    err: "#ef4444",
    warn: "#f59e0b",
    info: "#38bdf8",
    mute: "gray",
  },
  rose: {
    gradFrom: "#f43f5e",
    gradTo: "#fb7185",
    brand: "#f43f5e",
    accent: "#fb7185",
    ok: "#22c55e",
    err: "#ef4444",
    warn: "#f59e0b",
    info: "#fda4af",
    mute: "gray",
  },
  amber: {
    gradFrom: "#f59e0b",
    gradTo: "#fde047",
    brand: "#f59e0b",
    accent: "#fbbf24",
    ok: "#22c55e",
    err: "#ef4444",
    warn: "#ea580c",
    info: "#fcd34d",
    mute: "gray",
  },
  mono: {
    gradFrom: "#64748b",
    gradTo: "#cbd5e1",
    brand: "#94a3b8",
    accent: "#cbd5e1",
    ok: "#22c55e",
    err: "#ef4444",
    warn: "#f59e0b",
    info: "#94a3b8",
    mute: "gray",
  },
};
export const THEME_NAMES = Object.keys(THEMES);

// Components share this object, so applying a theme must mutate it in place.
export const theme: Theme = { ...THEMES.default };

export function applyTheme(name?: string): string {
  const key = name && THEMES[name] ? name : "default";
  Object.assign(theme, THEMES[key]);
  return key;
}

function hexChannels(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function lerp(from: string, to: string, position: number): string {
  const start = hexChannels(from);
  const end = hexChannels(to);
  const channel = (index: number) =>
    Math.round(start[index] + (end[index] - start[index]) * position)
      .toString(16)
      .padStart(2, "0");

  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

export function Grad({
  text,
  from = theme.gradFrom,
  to = theme.gradTo,
  bold = true,
}: {
  text: string;
  from?: string;
  to?: string;
  bold?: boolean;
}) {
  if (output.plain) {
    return <Text bold={bold}>{text}</Text>;
  }

  const length = text.length;
  return (
    <Text bold={bold}>
      {[...text].map((character, index) => (
        <Text
          key={index}
          color={lerp(from, to, length < 2 ? 0 : index / (length - 1))}
        >
          {character}
        </Text>
      ))}
    </Text>
  );
}

// Blend a color toward black. Lets a themed element recede without leaving the palette.
export function darken(color: string, amount: number): string {
  return lerp(color, "#000000", Math.max(0, Math.min(1, amount)));
}

export function GradLine({
  text,
  from = theme.gradFrom,
  to = theme.gradTo,
  bold = true,
  color = "#ffffff",
  plainDim = false,
}: {
  text: string;
  from?: string;
  to?: string;
  bold?: boolean;
  color?: string;
  plainDim?: boolean;
}) {
  if (output.plain) {
    return (
      <Text bold={bold} dimColor={plainDim}>
        {text}
      </Text>
    );
  }

  const length = text.length;
  return (
    <Text bold={bold}>
      {[...text].map((character, index) => (
        <Text
          key={index}
          backgroundColor={lerp(from, to, length < 2 ? 0 : index / (length - 1))}
          color={color}
        >
          {character}
        </Text>
      ))}
    </Text>
  );
}

export function Rule({ width = 50 }: { width?: number }) {
  return <Grad text={"─".repeat(width)} bold={false} />;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useFrame(interval = 80): number {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (output.plain) {
      return;
    }

    const timer = setInterval(() => setFrame((current) => current + 1), interval);
    return () => clearInterval(timer);
  }, [interval]);

  return frame;
}

export function Spinner({ label, color = theme.info }: { label: string; color?: string }) {
  const frame = useFrame();
  return (
    <Text>
      <Text color={color}>{FRAMES[frame % FRAMES.length]}</Text> {label}
      <Text dimColor>…</Text>
    </Text>
  );
}

export function Badge({ text, color = theme.brand }: { text: string; color?: string }) {
  if (output.plain) {
    return <Text bold>{`[${text}]`}</Text>;
  }

  return (
    <Text backgroundColor={color} color="#000000" bold>
      {` ${text} `}
    </Text>
  );
}

export function Header({ cmd }: { cmd: string }) {
  return (
    <Box marginBottom={1}>
      <Text>
        <Grad text="qinit" />
        <Text dimColor>{"  ▸  "}</Text>
        <Text bold color={theme.accent}>
          {cmd}
        </Text>
      </Text>
    </Box>
  );
}

export function Banner({ version, tagline }: { version: string; tagline: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1} alignSelf="flex-start">
        <Text>
          <Text color={theme.accent}>◆ </Text>
          <Grad text="qinit" />
          <Text dimColor>{"   "}</Text>
          <Badge text={`v${version}`} color={theme.brand} />
          <Text dimColor>{`   ${tagline}`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

export function Panel({
  title,
  color = theme.info,
  children,
}: {
  title?: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column">
      {title && (
        <Box>
          <Badge text={title} color={color} />
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        flexDirection="column"
        alignSelf="flex-start"
      >
        {children}
      </Box>
    </Box>
  );
}

export function Status({
  ok,
  label,
  detail,
  pad = 22,
}: {
  ok?: boolean | null;
  label: string;
  detail?: string;
  pad?: number;
}) {
  const glyph = ok === true ? "✓" : ok === false ? "✗" : "•";
  const color = ok === true ? theme.ok : ok === false ? theme.err : theme.info;

  return (
    <Text>
      <Text color={color}>{glyph}</Text> <Text bold>{label.padEnd(pad)}</Text>
      {detail ? (
        <Text dimColor>{truncMid(detail, Math.max(12, termCols() - pad - 8))}</Text>
      ) : null}
    </Text>
  );
}

export function KV({ rows, full }: { rows: [string, string][]; full?: boolean }) {
  const labelWidth = Math.max(0, ...rows.map(([label]) => label.length));

  return (
    <Box flexDirection="column">
      {rows.map(([label, value], index) => (
        <Text key={index}>
          <Text color={theme.info}>{label.padEnd(labelWidth)}</Text>{" "}
          <Text wrap={full ? "wrap" : undefined}>
            {full
              ? value
              : truncMid(value, Math.max(12, termCols() - labelWidth - 8))}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

export type StepState = "pending" | "active" | "ok" | "fail";

export function Step({
  state,
  label,
  detail,
}: {
  state: StepState;
  label: string;
  detail?: string;
}) {
  const frame = useFrame();
  const glyph =
    state === "ok" ? (
      <Text color={theme.ok}>✓</Text>
    ) : state === "fail" ? (
      <Text color={theme.err}>✗</Text>
    ) : state === "active" ? (
      <Text color={theme.info}>{FRAMES[frame % FRAMES.length]}</Text>
    ) : (
      <Text dimColor>◌</Text>
    );
  const labelColor = state === "pending" ? theme.mute : undefined;

  return (
    <Text>
      {glyph}{" "}
      <Text bold={state !== "pending"} color={labelColor}>
        {label}
      </Text>
      {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
    </Text>
  );
}

export function Bar({ pct, width = 22 }: { pct: number; width?: number }) {
  const progress = Math.max(0, Math.min(1, pct || 0));
  const fill = Math.round(progress * width);

  if (output.plain) {
    return (
      <Text>
        {"█".repeat(fill)}{"░".repeat(Math.max(0, width - fill))}{" "}
        {Math.round(progress * 100)}%
      </Text>
    );
  }

  const cells = Array.from({ length: width }, (_, index) =>
    index < fill ? (
      <Text
        key={index}
        color={lerp(
          theme.gradFrom,
          theme.gradTo,
          width < 2 ? 0 : index / (width - 1),
        )}
      >
        █
      </Text>
    ) : (
      <Text key={index} dimColor>
        ░
      </Text>
    ),
  );

  return (
    <Text>
      <Text color={theme.gradFrom}>▕</Text>
      {cells}
      <Text color={theme.gradTo}>▏</Text>{" "}
      <Text dimColor>{Math.round(progress * 100)}%</Text>
    </Text>
  );
}

export const fmtMs = (ms?: number) =>
  ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

export const termCols = () => Math.max(40, process.stdout.columns || 80);

// Terminal size that re-renders on resize — for full-height layouts that pin something to the last row.
// termCols() above stays for one-shot commands that only need the width once.
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({
    columns: Math.max(40, stdout?.columns || 80),
    rows: Math.max(10, stdout?.rows || 24),
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

const COMPACT_UNITS = ["", "K", "M", "B", "T", "P", "E"];

// Compact a decimal amount string for a narrow cell: "32000000000000" -> "32.0 T". Works on the digit
// string rather than Number, so amounts past 2^53 stay correct.
export function fmtCompact(amount: string): string {
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(digits)) {
    return amount;
  }

  const unit = Math.min(COMPACT_UNITS.length - 1, Math.floor((digits.length - 1) / 3));
  const sign = negative ? "-" : "";
  if (unit === 0) {
    return sign + digits;
  }

  const whole = digits.slice(0, digits.length - unit * 3);
  const fraction = digits.slice(whole.length, whole.length + 1);
  return `${sign}${whole}.${fraction} ${COMPACT_UNITS[unit]}`;
}
export const truncEnd = (s: string, max: number) =>
  s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";

export const truncMid = (s: string, max: number) => {
  if (s.length <= max) {
    return s;
  }

  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
};

export function StepRow({
  state,
  label,
  detail,
  pct,
  elapsedMs,
}: {
  state: StepState;
  label: string;
  detail?: string;
  pct?: number;
  elapsedMs?: number;
}) {
  const frame = useFrame();
  const glyph =
    state === "ok" ? (
      <Text color={theme.ok}>✓</Text>
    ) : state === "fail" ? (
      <Text color={theme.err}>✗</Text>
    ) : state === "active" ? (
      <Text color={theme.info}>{FRAMES[frame % FRAMES.length]}</Text>
    ) : (
      <Text dimColor>◌</Text>
    );

  return (
    <Text>
      {glyph}{" "}
      <Text bold={state !== "pending"} color={state === "pending" ? theme.mute : undefined}>
        {label.padEnd(14)}
      </Text>
      {pct != null && state === "active" ? (
        <Bar pct={pct} />
      ) : detail ? (
        <Text dimColor>{truncEnd(detail, Math.max(12, termCols() - 24))}</Text>
      ) : null}
      {state === "ok" && elapsedMs ? (
        <Text dimColor>{`  ${fmtMs(elapsedMs)}`}</Text>
      ) : null}
    </Text>
  );
}

// A titled section divider: `▌ RECENT TICKS  20 newest first ─────────`. The trailing hairline is what
// separates one region from the next without spending a whole bordered box on it.
export function SectionHeader({
  title,
  detail,
  badge,
  badgeColor,
  error,
  width,
}: {
  title: string;
  detail?: string;
  badge?: string;
  badgeColor?: string;
  error?: string;
  width?: number;
}) {
  const total = width ?? termCols();
  const label = title.toUpperCase();
  // Badges and errors are variable-width; the rule just fills whatever is left over.
  const used = 2 + label.length + (detail ? detail.length + 2 : 0) + (badge ? badge.length + 4 : 0);
  // Leave the terminal's last cell empty: a header filling it exactly wraps on some terminals.
  const rule = Math.max(0, total - used - (error ? error.length + 2 : 0) - 2);

  return (
    <Box marginTop={1}>
      <Text>
        <Text color={theme.brand}>▌</Text>{" "}
        <Text bold color={theme.accent}>
          {label}
        </Text>
        {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
        {badge ? (
          <Text>
            {"  "}
            <Badge text={badge} color={badgeColor ?? theme.err} />
          </Text>
        ) : null}
        {error ? <Text color={theme.err}>{`  ${error}`}</Text> : null}
        {rule > 0 ? <Text dimColor>{` ${"─".repeat(rule)}`}</Text> : null}
      </Text>
    </Box>
  );
}

export interface TileSpec {
  title: string;
  value: string;
  color?: string;
}

// A stat box with its title drawn into the top border. Ink has no border-title prop, so the box is
// composed by hand — which also keeps the width exact for row layout.
export function Tile({ title, value, color = theme.brand, width = 18 }: TileSpec & { width?: number }) {
  const label = title.toUpperCase();
  const inner = Math.max(label.length + 4, width - 2);
  const top = `╭─ ${label} ${"─".repeat(Math.max(0, inner - label.length - 3))}╮`;
  const shown = truncEnd(value, inner - 2);

  return (
    <Box flexDirection="column">
      <Text color={output.plain ? undefined : color} dimColor={output.plain}>
        {top}
      </Text>
      <Text>
        <Text color={output.plain ? undefined : color} dimColor={output.plain}>
          │
        </Text>
        <Text bold>{` ${shown.padEnd(inner - 2)} `}</Text>
        <Text color={output.plain ? undefined : color} dimColor={output.plain}>
          │
        </Text>
      </Text>
      <Text color={output.plain ? undefined : color} dimColor={output.plain}>
        {`╰${"─".repeat(inner)}╯`}
      </Text>
    </Box>
  );
}

// Tiles laid out left to right, wrapping to another row when the terminal is too narrow.
export function TileRow({
  tiles,
  columns,
  tileWidth = 18,
}: {
  tiles: TileSpec[];
  columns?: number;
  tileWidth?: number;
}) {
  const total = columns ?? termCols();
  const perRow = Math.max(1, Math.floor(total / (tileWidth + 1)));
  const lines: TileSpec[][] = [];
  for (let index = 0; index < tiles.length; index += perRow) {
    lines.push(tiles.slice(index, index + perRow));
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, lineIndex) => (
        <Box key={lineIndex} flexDirection="row">
          {line.map((tile, index) => (
            <Box key={index} marginRight={index < line.length - 1 ? 1 : 0}>
              <Tile {...tile} width={tileWidth} />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export interface SparkRow {
  label: string;
  value: number;
}

// Proportional bars scaled to the largest row — a readable stand-in for the web explorer's mempool chart.
export function Sparkline({ rows, width = 16 }: { rows: SparkRow[]; width?: number }) {
  const peak = Math.max(1, ...rows.map((row) => row.value));
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length));

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        const fill = Math.round((row.value / peak) * width);
        return (
          <Text key={index}>
            <Text dimColor>{row.label.padStart(labelWidth)}</Text>{" "}
            <Text color={output.plain ? undefined : theme.brand}>{"█".repeat(fill)}</Text>
            <Text dimColor>{"░".repeat(Math.max(0, width - fill))}</Text>{" "}
            <Text>{row.value}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export interface Column {
  header: string;
  align?: "left" | "right";
  color?: string;
  dim?: boolean;
  max?: number;
}
export function Table({
  columns,
  rows,
  selected,
  rowColor,
  width,
}: {
  columns: Column[];
  rows: string[][];
  selected?: number;
  rowColor?: (i: number) => string | undefined;
  // Available width, when the table is not flush against the terminal edge (e.g. inside an indented section).
  width?: number;
}) {
  const gap = 2;
  const widths = columns.map((column, index) => {
    const width = Math.max(
      column.header.length,
      0,
      ...rows.map((row) => (row[index] ?? "").length),
    );
    return column.max ? Math.min(width, column.max) : width;
  });

  let over =
    widths.reduce((sum, columnWidth) => sum + columnWidth, 0) +
    gap * Math.max(0, columns.length - 1) -
    (width ?? termCols());

  while (over > 0) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[widest]) {
        widest = i;
      }
    }
    if (widths[widest] <= 6) {
      break;
    }

    widths[widest]--;
    over--;
  }

  const cell = (value: string, index: number) => {
    const truncated = truncMid(value ?? "", widths[index]);
    return columns[index].align === "right"
      ? truncated.padStart(widths[index])
      : truncated.padEnd(widths[index]);
  };

  const spacing = " ".repeat(gap);
  const rowText = (cells: string[]) =>
    columns
      .map(
        (_, index) =>
          cell(cells[index] ?? "", index) +
          (index < columns.length - 1 ? spacing : ""),
      )
      .join("");

  // The header shares the selected row's gradient, so it needs to read as chrome rather than as a
  // selection: same palette, darkened and running the other way, with muted text.
  const Header = () => (
    <Box>
      <GradLine
        text={rowText(columns.map((column) => column.header))}
        from={darken(theme.gradTo, 0.62)}
        to={darken(theme.gradFrom, 0.62)}
        color={theme.mute}
        plainDim
      />
    </Box>
  );

  const Row = ({ row, index }: { row: string[]; index: number }) => {
    if (index === selected) {
      return (
        <Box>
          <GradLine text={rowText(row)} />
        </Box>
      );
    }

    const color = rowColor?.(index);
    return (
      <Box>
        {columns.map((column, columnIndex) => (
          <Text
            key={columnIndex}
            dimColor={column.dim && !color}
            color={color ?? column.color}
          >
            {cell(row[columnIndex] ?? "", columnIndex)}
            {columnIndex < columns.length - 1 ? spacing : ""}
          </Text>
        ))}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Header />
      {rows.map((row, index) => (
        <Row key={index} row={row} index={index} />
      ))}
    </Box>
  );
}
