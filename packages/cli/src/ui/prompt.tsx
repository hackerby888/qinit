// Keyboard-driven input widgets. Both grab the terminal with useInput, so exactly one may be mounted
// at a time — a caller that has its own key handling must stand down while a prompt is up.
import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { windowOf } from "./format";
import { useTerminalSize } from "./hooks";
import { theme } from "./theme";

const COMPLETION_DELAY_MS = 300;

// The label, both borders and the hint line — what a Select's list shares its frame with.
const SELECT_FIXED_ROWS = 4;

export type SelItem<T> = { label: string; value?: T; header?: boolean };

const firstSelectable = <T,>(items: SelItem<T>[]) =>
    Math.max(
        0,
        items.findIndex((item) => !item.header),
    );

// Case-insensitive substring match on the label. A group header never matches on its own text, and one
// survives only when a row under it does.
export function filterItems<T>(items: SelItem<T>[], query: string): SelItem<T>[] {
    if (!query) {
        return items;
    }

    const needle = query.toLowerCase();
    const kept: SelItem<T>[] = [];
    let pendingHeader: SelItem<T> | null = null;

    for (const item of items) {
        if (item.header) {
            pendingHeader = item;
            continue;
        }
        if (!item.label.toLowerCase().includes(needle)) {
            continue;
        }
        if (pendingHeader) {
            kept.push(pendingHeader);
            pendingHeader = null;
        }
        kept.push(item);
    }

    return kept;
}

// A vertical picker. `header` items are non-selectable group labels that ↑/↓ skips over. The list is
// windowed to the terminal, and `/` opens a filter over the labels.
export function Select<T>({
    label,
    items,
    onSelect,
    onCancel,
    reserve = 2,
}: {
    label: string;
    items: SelItem<T>[];
    onSelect: (value: T) => void;
    onCancel: () => void;
    // Rows the caller draws above the picker; the default is a <Header> and its margin.
    reserve?: number;
}) {
    const [selected, setSelected] = useState(() => firstSelectable(items));
    const [searching, setSearching] = useState(false);
    const [query, setQuery] = useState("");
    const { rows } = useTerminalSize();

    // The search matches whole labels, so digits also hit whatever index or count columns a caller folded in.
    const visible = filterItems(items, query);
    // Ink reprints the whole frame once it reaches the terminal height, so the list has to stop a row short.
    const { win, offset } = windowOf(visible, selected, rows - 1 - reserve - SELECT_FIXED_ROWS);

    const step = (direction: number) => {
        setSelected((current) => {
            let next = current;
            for (let i = 0; i < visible.length; i++) {
                next = (next + direction + visible.length) % visible.length;
                if (!visible[next].header) {
                    return next;
                }
            }
            return current;
        });
    };

    // Reseat the cursor on every list change here rather than in an effect — callers rebuild `items` each
    // render, so an effect keyed on it would never settle.
    const retype = (nextQuery: string) => {
        setQuery(nextQuery);
        setSelected(firstSelectable(filterItems(items, nextQuery)));
    };

    const endSearch = () => {
        setSearching(false);
        setQuery("");
        setSelected(firstSelectable(items));
    };

    useInput((input, key) => {
        if (key.escape) {
            if (searching) {
                endSearch();
            } else {
                onCancel();
            }
        } else if (key.upArrow) {
            step(-1);
        } else if (key.downArrow) {
            step(1);
        } else if (key.return) {
            // Its own branch: ink delivers ↵ as "\r", which a failed compound test would type into the query.
            const item = visible[selected];
            if (item && !item.header) {
                onSelect(item.value as T);
            }
        } else if (!searching) {
            if (input === "/") {
                setSearching(true);
            }
        } else if (key.backspace || key.delete) {
            retype(query.slice(0, -1));
        } else if (input && !key.ctrl && !key.meta) {
            retype(query + input);
        }
    });

    // Doubles as the scroll position and the match count, which is what a windowed list would otherwise
    // spend two rows saying.
    const rank = visible.slice(0, selected + 1).filter((item) => !item.header).length;
    const total = visible.filter((item) => !item.header).length;
    const keys = searching ? `/${query} ⌫ · esc clear` : "/ search · esc back";
    const hint = ` ↑/↓ move · ↵ select · ${keys} · ${rank}/${total}`;

    return (
        <Box flexDirection="column">
            <Text bold color={theme.accent}>
                {label}
            </Text>
            <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
                {win.map((item, index) => {
                    const current = offset + index === selected;
                    return item.header ? (
                        <Text key={offset + index} color={theme.mute} bold wrap="truncate">
                            {"  "}
                            {item.label}
                        </Text>
                    ) : (
                        // Truncated, not wrapped: a row spilling onto a second line would break the height budget.
                        <Text key={offset + index} wrap="truncate">
                            {current ? (
                                <Text color={theme.brand} bold>
                                    ▸{" "}
                                </Text>
                            ) : (
                                <Text>{"  "}</Text>
                            )}
                            <Text color={current ? theme.info : undefined} bold={current}>
                                {item.label}
                            </Text>
                        </Text>
                    );
                })}
                {!win.length && <Text dimColor>{searching ? "(no match)" : "(none)"}</Text>}
            </Box>
            <Text dimColor wrap="truncate">
                {hint}
            </Text>
        </Box>
    );
}

// `isActive: false` parks the field: still renders dimmed but takes no keys — which is how a form can
// mount several at once and still honour the one-keyboard-owner rule above.
export function TextPrompt({
    label,
    initial,
    onSubmit,
    complete,
    placeholder,
    isActive = true,
    hint,
    onChange,
}: {
    label: string;
    initial?: string;
    onSubmit: (value: string) => void;
    complete?: (value: string, idle: boolean) => string | null;
    placeholder?: string;
    isActive?: boolean;
    hint?: ReactNode;
    onChange?: (value: string) => void;
}) {
    const [value, setValue] = useState(initial ?? "");
    const [caret, setCaret] = useState((initial ?? "").length);
    const [completionIdle, setCompletionIdle] = useState(false);
    const completion = complete?.(value, completionIdle) ?? null;
    const completionSuffix = completion && completion.length > value.length && completion.startsWith(value) ? completion.slice(value.length) : "";

    const update = (nextValue: string, nextCaret?: number) => {
        setCompletionIdle(false);
        setValue(nextValue);
        setCaret(Math.max(0, Math.min(nextValue.length, nextCaret ?? nextValue.length)));
        onChange?.(nextValue);
    };

    useEffect(() => {
        if (!complete || !isActive) {
            return;
        }
        const timer = setTimeout(() => setCompletionIdle(true), COMPLETION_DELAY_MS);
        return () => clearTimeout(timer);
    }, [value, complete, isActive]);

    useInput(
        (input, key) => {
            if (key.return) {
                onSubmit(value);
            } else if (key.tab && completion) {
                update(completion);
            } else if (key.leftArrow) {
                setCaret((current) => Math.max(0, current - 1));
            } else if (key.rightArrow) {
                if (value === "" && placeholder) {
                    update(placeholder);
                } else {
                    setCaret((current) => Math.min(value.length, current + 1));
                }
            } else if (key.ctrl && input === "a") {
                setCaret(0);
            } else if (key.ctrl && input === "e") {
                setCaret(value.length);
            } else if (key.backspace || key.delete) {
                if (caret > 0) {
                    update(value.slice(0, caret - 1) + value.slice(caret), caret - 1);
                }
            } else if (input && !key.ctrl && !key.meta) {
                update(value.slice(0, caret) + input + value.slice(caret), caret + input.length);
            }
        },
        { isActive },
    );

    const before = value.slice(0, caret);
    const atCaret = value.slice(caret, caret + 1) || " ";
    const after = value.slice(caret + 1);

    // A parked field shows no caret and no key hints — both would advertise a keyboard it does not own.
    const caretMarker = isActive ? (
        <Text inverse>{value === "" && placeholder ? " " : atCaret}</Text>
    ) : (
        <Text>{value === "" && placeholder ? " " : atCaret}</Text>
    );

    return (
        <Box flexDirection="column">
            <Box borderStyle="round" borderColor={isActive ? theme.brand : theme.mute} paddingX={1}>
                {value === "" && placeholder ? (
                    <Text>
                        <Text color={isActive ? theme.brand : theme.mute} bold={isActive}>
                            ❯{" "}
                        </Text>
                        {caretMarker}
                        <Text color={theme.mute} dimColor>
                            {placeholder}
                        </Text>
                    </Text>
                ) : (
                    <Text>
                        <Text color={isActive ? theme.brand : theme.mute} bold={isActive}>
                            ❯{" "}
                        </Text>
                        <Text color={isActive ? theme.ok : undefined} dimColor={!isActive}>
                            {before}
                        </Text>
                        {caretMarker}
                        <Text color={isActive ? theme.ok : undefined} dimColor={!isActive}>
                            {after}
                        </Text>
                        <Text color={theme.mute} dimColor>
                            {completionSuffix}
                        </Text>
                    </Text>
                )}
            </Box>
            {hint ?? null}
            {isActive ? (
                <Text color={theme.mute} dimColor>
                    {" "}
                    {label}
                    {completionSuffix ? `    ⇥ tab → ${completion}` : value === "" && placeholder ? "    → fill template · ↵ submit" : "    ↵ submit"} esc back
                </Text>
            ) : (
                <Text color={theme.mute} dimColor>
                    {" "}
                    {label}
                </Text>
            )}
        </Box>
    );
}
