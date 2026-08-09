// Shared compact views over trace-format's decoded data — rendered identically by `qinit debug` (detail pane),
// `qinit call --trace`, and `qinit state`. Style: a Status header line + indented label->value rows.
import { Box, Text } from "ink";
import { type DebugEntry } from "@qinit/core";
import { Status, theme, truncEnd, truncMid, termCols } from "../ui";
import {
  type DecodedTrace,
  type DecodedState,
  type StateContainer,
  sevColor,
  jstr,
} from "./format";
import { type StateDiffLine } from "./state-diff";

const kindName = (k: number) => (k === 0 ? "fn" : k === 1 ? "proc" : "sys");
const execµs = (ns: number) =>
  ns < 1_000_000 ? `${(ns / 1000) | 0}µs` : `${(ns / 1e6).toFixed(1)}ms`;

// indented label -> value row block (the "compact section")
function Rows({
  rows,
  width,
}: {
  rows: { label: string; node: React.ReactNode }[];
  width?: number;
}) {
  const w = width ?? Math.max(1, ...rows.map((r) => r.label.length));
  return (
    <Box flexDirection="column" marginLeft={2}>
      {rows.map((r, i) => (
        <Text key={i}>
          <Text color={theme.info}>{r.label.padEnd(w)}</Text> {r.node}
        </Text>
      ))}
    </Box>
  );
}

// The rows a state block shows: everything in the full view, only what the contract wrote otherwise.
export const shownStateLines = (lines: StateDiffLine[], full: boolean) =>
  full ? lines : lines.filter((line) => !line.internal);

// The call's own state changes, one resolved element per row. Container rows below are current node
// state instead, so the two must not be read as the same thing. `full` keeps the container bookkeeping
// rows and their resolved paths; by default only what the contract itself wrote is shown.
//
// `maxRows` bounds the block to a window starting at `offset`, one line per row. A long-running view has
// to stay inside the terminal: Ink cannot erase a frame taller than the screen, so an overflowing block
// leaves its own stale rows behind on the next render.
function StateDiff({
  lines,
  truncated,
  full,
  hint,
  maxRows,
  offset = 0,
}: {
  lines: StateDiffLine[];
  truncated: boolean;
  full: boolean;
  hint: string;
  maxRows?: number;
  offset?: number;
}) {
  const all = shownStateLines(lines, full);
  const start = maxRows ? Math.min(offset, Math.max(0, all.length - maxRows)) : 0;
  const shown = maxRows ? all.slice(start, start + maxRows) : all;
  const labelOf = (line: StateDiffLine) => (full ? line.detail : line.label);
  const width = Math.max(1, ...shown.map((line) => labelOf(line).length));
  const hidden = lines.length - all.length;

  const tail: string[] = [];
  if (start) {
    tail.push(`${start} above`);
  }
  if (start + shown.length < all.length) {
    tail.push(`${all.length - start - shown.length} below`);
  }
  if (tail.length) {
    tail.push("pgup/pgdn");
  }
  if (hidden) {
    tail.push(`${hidden} container internals hidden · ${hint}`);
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color={theme.info}>state</Text>
        {lines.length ? null : <Text dimColor> (no change)</Text>}
        {truncated ? <Text color={theme.warn}> (truncated)</Text> : null}
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {shown.map((line, index) => (
          <Text
            key={index}
            wrap={maxRows ? "truncate-end" : "wrap"}
            dimColor={!line.filled}
          >
            <Text color={line.filled ? theme.accent : undefined} bold={line.filled}>
              {labelOf(line).padEnd(width)}
            </Text>{" "}
            {line.text}
          </Text>
        ))}
        {tail.length ? (
          <Text color={theme.mute} dimColor>
            ⋯ {tail.join(" · ")}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

// One decoded contract-call trace, compact. `view` = describeTrace(e, ...). `fullState` shows the state
// block's container internals, and `stateHint` names whatever turns them on in the calling command.
export function TraceView({
  e,
  name,
  view,
  fullState = false,
  stateHint,
  maxStateRows,
  stateOffset,
}: {
  e: DebugEntry;
  name: string;
  view: DecodedTrace;
  fullState?: boolean;
  stateHint: string;
  maxStateRows?: number;
  stateOffset?: number;
}) {
  const callRows: { label: string; node: React.ReactNode }[] = [
    { label: "in", node: <Text>{truncEnd(view.inDecoded, termCols() - 8)}</Text> },
    { label: "out", node: <Text>{truncEnd(view.outDecoded, termCols() - 8)}</Text> },
  ];
  if (e.kind === 1) callRows.push({ label: "caller", node: <Text wrap="wrap">{view.caller}</Text> }); // full id — copy-pasteable

  const rows: { label: string; node: React.ReactNode }[] = [];
  for (const container of view.containers)
    rows.push({
      label: container.name,
      node: (
        <Text dimColor>
          {truncMid(container.entries.join(", ") || "empty", termCols() - 12)}
        </Text>
      ),
    });
  for (const l of view.logs)
    rows.push({
      label: "log",
      node: (
        <Text>
          <Text bold color={sevColor(l.severity)}>
            {l.severity}
          </Text>{" "}
          {l.name ? (
            <Text>
              {l.name}
              {l.typeName ? "·" + l.typeName : ""} <Text dimColor>{jstr(l.fields)}</Text>
            </Text>
          ) : (
            <Text dimColor>{l.size}B</Text>
          )}
        </Text>
      ),
    });
  for (const h of e.hostCalls)
    rows.push({
      label: "host",
      node: (
        <Text>
          <Text color={theme.accent}>{h.name}</Text> <Text dimColor>{h.detail}</Text>
        </Text>
      ),
    });
  if (e.trap)
    rows.push({
      label: "trap",
      node: (
        <Text color={theme.err} wrap="wrap">
          {e.trap}
        </Text>
      ),
    });
  // One label column across both blocks, so the state block does not sit at its own indent.
  const width = Math.max(5, ...[...callRows, ...rows].map((row) => row.label.length));

  return (
    <Box flexDirection="column">
      <Status
        ok={e.ok}
        label={`${name} ${kindName(e.kind)}#${e.entry}`}
        detail={`${execµs(e.execNs)} · tick ${e.tick}`}
        pad={Math.max(14, name.length + 8)}
      />
      <Rows rows={callRows} width={width} />
      <StateDiff
        lines={view.stateDiff}
        truncated={e.stateTruncated}
        full={fullState}
        hint={stateHint}
        maxRows={maxStateRows}
        offset={stateOffset}
      />
      <Rows rows={rows} width={width} />
    </Box>
  );
}

// An Array counts set elements; every other container counts occupied slots.
function containerDetail(container: StateContainer): string {
  if (container.error) {
    return "read failed";
  }
  if (!container.capacity) {
    return "empty";
  }

  const free = container.capacity - container.occupiedSlots;
  if (container.kind === "array") {
    return `${container.occupiedSlots} set · ${free}/${container.capacity} zero`;
  }

  const total = container.totalEntries;
  const slotLabel = container.kind === "collection" ? "PoV slots" : "slots";
  const count = total ? `${total} ${total === 1 ? "entry" : "entries"}` : "empty";
  return `${count} · ${free}/${container.capacity} ${slotLabel} unoccupied`;
}

// A contract's decoded current state (scalars + containers), compact.
export function StateView({ name, state }: { name: string; state: DecodedState }) {
  return (
    <Box flexDirection="column">
      <Status
        ok={state.complete ? null : false}
        label={`${name} state`}
        detail={state.complete ? undefined : "incomplete"}
      />
      {state.fields.length ? (
        <Rows
          rows={state.fields.map((field) => ({
            label: field.name,
            node: <Text wrap="wrap">{field.value}</Text>,
          }))}
        />
      ) : (
        <Box marginLeft={2}>
          <Text dimColor>no scalar fields</Text>
        </Box>
      )}
      {state.containers.map((container) => {
        const width = Math.max(
          1,
          ...container.lines.map((line) => line.label.length),
        );

        return (
          <Box key={container.name} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={theme.accent}>{container.name}</Text>{" "}
              <Text dimColor>· {containerDetail(container)}</Text>
            </Text>
            <Box flexDirection="column" marginLeft={2}>
              {container.error ? (
                <Text color={theme.err} wrap="wrap">
                  {container.error}
                </Text>
              ) : container.lines.length ? (
                container.lines.map((line, index) => (
                  <Text key={index} wrap="wrap" dimColor={!line.filled}>
                    <Text
                      color={line.filled ? theme.accent : undefined}
                      bold={line.filled}
                    >
                      {line.label.padEnd(width)}
                    </Text>{" "}
                    {line.text}
                  </Text>
                ))
              ) : (
                <Text dimColor>empty</Text>
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
