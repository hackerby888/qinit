// Ways of showing records: key/value lists, stat tiles, bar charts, and the selectable table.
import { Box, Text } from "ink";
import { output } from "../args";
import { termCols, truncEnd, truncMid } from "./format";
import { GradLine, darken, theme } from "./theme";

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
  // A function is asked per row, and its answer outranks `rowColor` — a column that colors itself row by
  // row is the more specific signal.
  color?: string | ((rowIndex: number) => string | undefined);
  dim?: boolean;
  max?: number;
  // Where a cell too wide for its column loses characters. The middle by default, which keeps both ends of
  // a name; "end" is for values whose head identifies them, like an entry's kind and number.
  truncate?: "mid" | "end";
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
    const truncated =
      columns[index].truncate === "end"
        ? truncEnd(value ?? "", widths[index])
        : truncMid(value ?? "", widths[index]);
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
        {columns.map((column, columnIndex) => {
          const perRowColor =
            typeof column.color === "function" ? column.color(index) : undefined;
          const staticColor = typeof column.color === "string" ? column.color : undefined;

          return (
            <Text
              key={columnIndex}
              dimColor={column.dim && !color}
              color={perRowColor ?? color ?? staticColor}
            >
              {cell(row[columnIndex] ?? "", columnIndex)}
              {columnIndex < columns.length - 1 ? spacing : ""}
            </Text>
          );
        })}
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
