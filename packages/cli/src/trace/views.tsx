// Shared compact views over trace-format's decoded data — rendered identically by `qinit debug` (detail pane),
// `qinit call --trace`, and `qinit state`. Style: a Status header line + indented label->value rows.
import { Box, Text } from "ink";
import { type DebugEntry } from "@qinit/core";
import { Status, theme, truncEnd, truncMid, termCols } from "../ui";
import { type DecodedTrace, type DecodedState, type StateContainer, sevColor, formatStateValue, jstr } from "./format";
import { entryLabel } from "./entry-label";
import { type StateDiffLine } from "./state-diff";

const execµs = (ns: number) => (ns < 1_000_000 ? `${(ns / 1000) | 0}µs` : `${(ns / 1e6).toFixed(1)}ms`);

// indented label -> value row block (the "compact section")
// `truncate` pins every row to a single line, which is what lets a bounded caller budget rows as lines.
function Rows({ rows, width, truncate }: { rows: { label: string; node: React.ReactNode }[]; width?: number; truncate?: boolean }) {
    const w = width ?? Math.max(1, ...rows.map((r) => r.label.length));
    return (
        <Box flexDirection="column" marginLeft={2}>
            {rows.map((r, i) => (
                <Text key={i} wrap={truncate ? "truncate-end" : undefined}>
                    <Text color={theme.info}>{r.label.padEnd(w)}</Text> {r.node}
                </Text>
            ))}
        </Box>
    );
}

// Internal bookkeeping is opt-in; payload and population changes stay visible.
export const shownStateLines = (lines: StateDiffLine[], showInternals: boolean) => (showInternals ? lines : lines.filter((line) => !line.internal));

// The call's captured state changes, one resolved element per row. Internal bookkeeping is opt-in.
//
// `maxRows` bounds the block to a window starting at `offset`, one line per row. A long-running view has
// to stay inside the terminal: Ink cannot erase a frame taller than the screen, so an overflowing block
// leaves its own stale rows behind on the next render.
function StateDiff({
    lines,
    truncated,
    showInternals,
    internalsHint,
    maxRows,
    offset = 0,
}: {
    lines: StateDiffLine[];
    truncated: boolean;
    showInternals: boolean;
    internalsHint: string;
    maxRows?: number;
    offset?: number;
}) {
    const all = shownStateLines(lines, showInternals);
    const start = maxRows ? Math.min(offset, Math.max(0, all.length - maxRows)) : 0;
    const shown = maxRows ? all.slice(start, start + maxRows) : all;
    const labelOf = (line: StateDiffLine) => (showInternals ? line.detail : line.label);
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
        tail.push(`${hidden} container internals hidden · ${internalsHint}`);
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
                    <Text key={index} wrap={maxRows ? "truncate-end" : "wrap"} dimColor={!line.filled}>
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

// One decoded contract-call trace. `showInternals` reveals captured container bookkeeping.
//
// `width` is the pane this renders into, not the terminal — passing it also pins every row to one line,
// so a caller that budgets rows against the screen height gets the height it counted on.
export function TraceView({
    e,
    name,
    entry,
    view,
    showInternals = false,
    internalsHint,
    maxStateRows,
    stateOffset,
    width,
}: {
    e: DebugEntry;
    name: string;
    /** How the invoked entry is spelled, e.g. `proc#1 (Increase)`. Falls back to the kind and its number. */
    entry?: string;
    view: DecodedTrace;
    showInternals?: boolean;
    internalsHint: string;
    maxStateRows?: number;
    stateOffset?: number;
    width?: number;
}) {
    const bounded = width != null;
    const cols = width ?? termCols();
    const label = `${name} ${entry ?? entryLabel(e.kind, e.entry)}`;
    // Status has no wrap of its own, so a bounded pane has to size its two halves to fit on one line.
    const pad = bounded ? Math.max(1, Math.min(Math.max(14, label.length + 1), cols - 14)) : Math.max(14, label.length + 1);

    const callRows: { label: string; node: React.ReactNode }[] = [
        { label: "in", node: <Text>{truncEnd(view.inDecoded, cols - 8)}</Text> },
        { label: "out", node: <Text>{truncEnd(view.outDecoded, cols - 8)}</Text> },
    ];
    // Unbounded, the caller is the full id so it can be copy-pasted; a pane too narrow for it truncates.
    if (e.kind === 1)
        callRows.push({
            label: "caller",
            node: bounded ? <Text>{truncMid(view.caller, Math.max(12, cols - 12))}</Text> : <Text wrap="wrap">{view.caller}</Text>,
        });

    const rows: { label: string; node: React.ReactNode }[] = [];
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
                            {l.typeName ? "·" + l.typeName : ""} <Text dimColor>{l.abi ? formatStateValue(l.values, l.abi, false) : jstr(l.fields)}</Text>
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
                <Text color={theme.err} wrap={bounded ? undefined : "wrap"}>
                    {e.trap}
                </Text>
            ),
        });
    // One label column across both blocks, so the state block does not sit at its own indent.
    const labelWidth = Math.max(5, ...[...callRows, ...rows].map((row) => row.label.length));
    // Status measures its own detail against the terminal, which overflows a narrower pane — pre-cut it.
    // The glyph and its space are the 3rd column the detail has to leave room for.
    const detailMax = bounded ? cols - pad - 3 : Math.max(12, cols - pad - 8);
    const detail = truncMid(`${execµs(e.execNs)} · tick ${e.tick}`, detailMax);

    return (
        <Box flexDirection="column">
            <Status ok={e.ok} label={bounded ? truncEnd(label, pad) : label} detail={detailMax >= 6 ? detail : undefined} pad={pad} />
            <Rows rows={callRows} width={labelWidth} truncate={bounded} />
            <StateDiff
                lines={view.stateDiff}
                truncated={e.stateTruncated}
                showInternals={showInternals}
                internalsHint={internalsHint}
                maxRows={maxStateRows}
                offset={stateOffset}
            />
            <Rows rows={rows} width={labelWidth} truncate={bounded} />
        </Box>
    );
}

// Arrays and BitArrays count set elements; other containers count occupied slots.
function containerDetail(container: StateContainer, hidden: boolean, interactive: boolean): string {
    const selectionHint = interactive ? `press ${container.index}` : `use --container ${container.index}`;
    if (container.status === "collapsed") {
        return `${container.size.toLocaleString("en-US")} bytes · ${selectionHint} to load`;
    }
    if (container.status === "loading") {
        return "loading";
    }
    if (container.status === "error") {
        return `read failed · ${selectionHint} to retry`;
    }
    if (hidden) {
        return `cached · hidden · press ${container.index} to show`;
    }
    if (!container.capacity) {
        return "empty";
    }

    const free = container.capacity - container.occupiedSlots;
    if (container.kind === "array" || container.kind === "bitarray") {
        return `${container.occupiedSlots} set · ${free}/${container.capacity} zero`;
    }

    const total = container.totalEntries;
    const slotLabel = container.kind === "collection" ? "PoV slots" : "slots";
    const count = total ? `${total} ${total === 1 ? "entry" : "entries"}` : "empty";
    return `${count} · ${free}/${container.capacity} ${slotLabel} unoccupied`;
}

// A contract's decoded current state (scalars + containers), compact.
export function StateView({
    name,
    state,
    hiddenContainerIndexes,
    interactive = false,
}: {
    name: string;
    state: DecodedState;
    hiddenContainerIndexes?: ReadonlySet<number>;
    interactive?: boolean;
}) {
    return (
        <Box flexDirection="column">
            <Status ok={state.complete ? null : false} label={`${name} state`} detail={state.complete ? undefined : "incomplete"} />
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
                const hidden = container.status === "loaded" && (hiddenContainerIndexes?.has(container.index) ?? false);
                const width = hidden || container.status !== "loaded" ? 1 : container.lines.reduce((maximum, line) => Math.max(maximum, line.label.length), 1);

                return (
                    <Box key={container.index} flexDirection="column" marginTop={1}>
                        <Text>
                            <Text color={theme.accent} dimColor={container.status === "collapsed"}>
                                [{container.index}] {container.name}
                            </Text>{" "}
                            <Text dimColor>· {containerDetail(container, hidden, interactive)}</Text>
                        </Text>
                        <Box flexDirection="column" marginLeft={2}>
                            {container.status === "error" ? (
                                <Text color={theme.err} wrap="wrap">
                                    {container.error}
                                </Text>
                            ) : container.status === "loading" ? (
                                <Text dimColor>loading…</Text>
                            ) : container.status === "collapsed" ? (
                                <Text dimColor>not read</Text>
                            ) : hidden ? null : container.lines.length ? (
                                container.lines.map((line, index) => (
                                    <Text key={index} wrap="wrap" dimColor={!line.filled}>
                                        <Text color={line.filled ? theme.accent : undefined} bold={line.filled}>
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
