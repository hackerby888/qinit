// The explorer's frame: the view model every screen is keyed by, the breadcrumb and control bar wrapped
// around the body, and the shared formatting the views all reach for.
import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { LiteRpc, contractIndexFromIdentity } from "@qinit/core";
import { entryFor, type ContractIdls } from "../../../contracts/idl-lookup";
import { Grad, theme, truncMid, useFrame } from "../../../ui";

export type View =
    | { kind: "overview" }
    | { kind: "find" }
    | { kind: "tick"; tick: number }
    | { kind: "tx"; hash: string; tick?: number }
    | { kind: "identity"; id?: string }
    | { kind: "contracts"; page: number }
    | { kind: "contract"; index: number }
    | { kind: "wallet"; to?: string };

// One stack frame per drill-down level. `selected` is kept per frame so popping back to a list restores
// the row the user came from instead of resetting to the top.
export interface Frame {
    view: View;
    selected: number;
}

export const fmtTime = (timestamp: string): string => {
    const seconds = Number(timestamp);
    if (!timestamp || !Number.isFinite(seconds) || seconds <= 0) {
        return "—";
    }
    return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
};

// Every row of a live list is from the same day, so only the clock part of the stamp earns its width.
export const fmtClock = (timestamp: string): string => {
    const full = fmtTime(timestamp);
    return full.length === 19 ? full.slice(11) : full;
};

// Amounts arrive as decimal strings and can exceed 2^53 — group digits without ever widening to Number.
export const fmtAmount = (amount: string): string => {
    const negative = amount.startsWith("-");
    const digits = negative ? amount.slice(1) : amount;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return negative ? `-${grouped}` : grouped;
};

export const errText = (e: unknown): string => String((e as Error)?.message ?? e);

// A destination that is really a contract address, labelled by slot.
export const contractLabel = (identity: string, names: Map<number, string>): string | null => {
    const index = contractIndexFromIdentity(identity);
    if (index == null) {
        return null;
    }
    return `${names.get(index) ?? "contract"} #${index}`;
};

// A call's inputType, named when the slot's IDL is known. A plain transfer misses the lookup and keeps
// its bare number, which is also what an unparsed contract falls back to.
export const entryLabel = (slot: number | null | undefined, inputType: number, idls: ContractIdls): string => {
    const entry = entryFor(slot, inputType, idls);
    return entry ? `${inputType} ${entry.name}` : String(inputType);
};

// Rows the shell owns above the body: the header with its margin, plus the breadcrumb.
export const CHROME_ROWS = 3;

// ---- breadcrumb + control bar -------------------------------------------------------------------------------------

const crumbOf = (view: View): string => {
    switch (view.kind) {
        case "overview":
            return "overview";
        case "find":
            return "find";
        case "tick":
            return `tick ${view.tick}`;
        case "tx":
            return `tx ${truncMid(view.hash, 12)}`;
        case "identity":
            return view.id ? `id ${truncMid(view.id, 12)}` : "identity";
        case "contracts":
            return view.page > 0 ? `contracts p${view.page + 1}` : "contracts";
        case "contract":
            return `contract #${view.index}`;
        case "wallet":
            return "wallet";
    }
};

// Section contents sit under the header's title rather than flush with its ▌ marker, so each block reads
// as belonging to its heading.
const SECTION_INDENT = 2;

// Table budget inside a section: the indent plus one spare column, so a full-width row can never land on
// the terminal's last cell and wrap.
export const sectionTableWidth = (columns: number) => columns - SECTION_INDENT - 1;

export function SectionBody({ children }: { children: ReactNode }) {
    return (
        <Box paddingLeft={SECTION_INDENT} flexDirection="column">
            {children}
        </Box>
    );
}

export function Breadcrumb({ stack }: { stack: Frame[] }) {
    return (
        <Text>
            {stack.map((frame, index) => (
                <Text key={index}>
                    {index > 0 ? <Text dimColor> › </Text> : null}
                    {index === stack.length - 1 ? (
                        <Text color={theme.brand} bold>
                            {crumbOf(frame.view)}
                        </Text>
                    ) : (
                        <Text dimColor>{crumbOf(frame.view)}</Text>
                    )}
                </Text>
            ))}
        </Text>
    );
}

// Only advertise keys the current view actually binds — stale hints are what make a TUI feel confusing.
// The key glyph carries the color and the label stays at normal weight; dimming the whole line is what
// made this bar disappear into the data above it.
type KeyHint = [key: string, label: string];

function keysFor(view: View, depth: number, searching: boolean): KeyHint[] {
    // The prompt owns every key except esc, so advertising the rest would be a lie.
    if (searching) {
        return [
            ["↵", "look up"],
            ["esc", "back"],
        ];
    }

    // The wallet is a form that owns every key, including esc — the shell binds none of its own there.
    // Its stage lives in component state, which this function cannot see, so only esc (true in every
    // stage) is advertised here and each stage draws its own keys in-body.
    if (view.kind === "wallet") {
        return [["esc", "back"]];
    }

    const keys: KeyHint[] = [
        ["1", "overview"],
        ["2", "contracts"],
        ["3", "identity"],
        ["4", "wallet"],
        ["/", "find"],
    ];

    const hasList =
        view.kind === "overview" ||
        view.kind === "tick" ||
        view.kind === "contracts" ||
        view.kind === "contract" ||
        (view.kind === "identity" && Boolean(view.id));
    if (hasList) {
        keys.push(["↑↓", "select"], ["↵", "open"]);
    }
    if (view.kind === "tick") {
        keys.push(["←→", "tick"]);
    } else if (view.kind === "contracts") {
        keys.push(["←→", "page"]);
    } else if (view.kind === "identity" && view.id) {
        keys.push(["s", "send to"]);
    }
    // esc leads back to the overview from any section root, so it is only meaningless on the overview itself.
    if (depth > 1 || view.kind !== "overview") {
        keys.push(["esc", "back"]);
    }
    keys.push(["r", "refresh"], ["t", "theme"], ["q", "quit"]);
    return keys;
}

const HINT_SEPARATOR = "  ·  ";

// The section a stack is rooted in. Drilling from the overview into a tick and then a transaction never
// leaves the overview tab, so the lit key follows the root frame rather than the visible view.
const TAB_KEY: Partial<Record<View["kind"], string>> = {
    overview: "1",
    tick: "1",
    tx: "1",
    contracts: "2",
    contract: "2",
    identity: "3",
};

// Frames per full sweep of the active tab's gradient, at the interval below.
const SWEEP_FRAMES = 20;
const SWEEP_MS = 120;

// Wrap hints into lines that fit the terminal. Labels are never dropped — a row of bare glyphs is harder
// to use than the bar this replaced. The shell asks for the line count so it can budget the rows.
export function hintLines(keys: KeyHint[], columns: number): KeyHint[][] {
    const lines: KeyHint[][] = [[]];
    let used = 0;

    for (const hint of keys) {
        const size = hint[0].length + 1 + hint[1].length;
        const withSeparator = lines[lines.length - 1].length > 0 ? size + HINT_SEPARATOR.length : size;
        if (used + withSeparator > columns - 1 && lines[lines.length - 1].length > 0) {
            lines.push([hint]);
            used = size;
            continue;
        }
        lines[lines.length - 1].push(hint);
        used += withSeparator;
    }

    return lines;
}

// Rule + wrapped hint lines + the status line.
export const controlBarRows = (view: View, depth: number, columns: number, searching: boolean): number =>
    2 + hintLines(keysFor(view, depth, searching), columns).length;

export function ControlBar({
    view,
    rootView,
    depth,
    themeName,
    rpcBaseUrl,
    columns,
    searching,
}: {
    view: View;
    rootView: View;
    depth: number;
    themeName: string;
    rpcBaseUrl: string;
    columns: number;
    searching: boolean;
}) {
    const lines = hintLines(keysFor(view, depth, searching), columns);
    const frame = useFrame(SWEEP_MS);
    // The prompt takes over the keyboard, so no tab is current while it is open.
    const activeKey = searching ? undefined : TAB_KEY[rootView.kind];

    return (
        <Box flexDirection="column">
            <Text dimColor>{"─".repeat(Math.max(0, columns - 1))}</Text>
            {lines.map((line, lineIndex) => (
                <Text key={lineIndex}>
                    {line.map(([key, label], index) => (
                        <Text key={key}>
                            {index > 0 ? <Text dimColor>{HINT_SEPARATOR}</Text> : null}
                            <Text bold color={theme.brand}>
                                {key}
                            </Text>
                            <Text> </Text>
                            {key === activeKey ? <Grad text={label} phase={(frame % SWEEP_FRAMES) / SWEEP_FRAMES} /> : <Text>{label}</Text>}
                        </Text>
                    ))}
                </Text>
            ))}
            <Text>
                <Text color={theme.ok}>●</Text> <Text dimColor>{rpcBaseUrl}</Text>
                <Text dimColor>{`   theme ${themeName}`}</Text>
            </Text>
        </Box>
    );
}

export interface ViewProps {
    rpc: LiteRpc;
    refreshToken: number;
    selected: number;
    contractNames: Map<number, string>;
    contractIdls: ContractIdls;
    push: (view: View) => void;
    rowCount: { current: number };
    openRow: { current: (index: number) => void };
    bodyRows: number;
    columns: number;
}

// Slice a list around the selected row. `budget` is the rows left after the view's own fixed block, so a
// long list can never grow past the shell and push the control bar off-screen.
export function windowOf<T>(rows: T[], selected: number, budget: number): { win: T[]; offset: number } {
    const size = Math.max(1, budget);
    const offset = Math.max(0, Math.min(selected - Math.floor(size / 2), rows.length - size));
    return { win: rows.slice(offset, offset + size), offset: Math.max(0, offset) };
}
