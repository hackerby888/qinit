// Shared compact views over trace-format's decoded data — rendered identically by `qinit debug` (detail pane),
// `qinit call --trace`, and `qinit state`. Style: a Status header line + indented label->value rows.
import { Box, Text } from "ink";
import { type DebugEntry } from "@qinit/core";
import { Status, theme, truncEnd, truncMid, termCols } from "../ui";
import {
  type DecodedTrace,
  type DecodedState,
  type StateContainer,
  labelOff,
  fmtDiffVal,
  sevColor,
  jstr,
} from "./format";

const kindName = (k: number) => (k === 0 ? "fn" : k === 1 ? "proc" : "sys");
const execµs = (ns: number) =>
  ns < 1_000_000 ? `${(ns / 1000) | 0}µs` : `${(ns / 1e6).toFixed(1)}ms`;

// indented label -> value row block (the "compact section")
function Rows({ rows }: { rows: { label: string; node: React.ReactNode }[] }) {
  const w = Math.max(1, ...rows.map((r) => r.label.length));
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

// One decoded contract-call trace, compact. `view` = describeTrace(e, ...).
export function TraceView({ e, name, view }: { e: DebugEntry; name: string; view: DecodedTrace }) {
  const rows: { label: string; node: React.ReactNode }[] = [
    { label: "in", node: <Text>{truncEnd(view.inDecoded, termCols() - 8)}</Text> },
    { label: "out", node: <Text>{truncEnd(view.outDecoded, termCols() - 8)}</Text> },
  ];
  if (e.kind === 1) rows.push({ label: "caller", node: <Text wrap="wrap">{view.caller}</Text> }); // full id — copy-pasteable
  rows.push({
    label: "state",
    node: e.stateDiff.length ? (
      <Text>
        {e.stateDiff.slice(0, 12).map((d, i) => (
          <Text key={i}>
            {i ? "  " : ""}
            <Text bold>{labelOff(view.fields, d.off)}</Text>{" "}
            <Text color={theme.err}>{fmtDiffVal(view.fields, d.off, d.before)}</Text>→
            <Text color={theme.ok}>{fmtDiffVal(view.fields, d.off, d.after)}</Text>
          </Text>
        ))}
        {e.stateTruncated ? <Text dimColor> (truncated)</Text> : null}
      </Text>
    ) : (
      <Text dimColor>(no change)</Text>
    ),
  });
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
  return (
    <Box flexDirection="column">
      <Status
        ok={e.ok}
        label={`${name} ${kindName(e.kind)}#${e.entry}`}
        detail={`${execµs(e.execNs)} · tick ${e.tick}`}
        pad={Math.max(14, name.length + 8)}
      />
      <Rows rows={rows} />
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
