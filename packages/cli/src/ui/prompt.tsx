// Keyboard-driven input widgets. Both grab the terminal with useInput, so exactly one may be mounted
// at a time — a caller that has its own key handling must stand down while a prompt is up.
import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme";

const COMPLETION_DELAY_MS = 300;

export type SelItem<T> = { label: string; value?: T; header?: boolean };

// A vertical picker. `header` items are non-selectable group labels that ↑/↓ skips over.
export function Select<T>({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: SelItem<T>[];
  onSelect: (value: T) => void;
}) {
  const firstSelectable = Math.max(
    0,
    items.findIndex((item) => !item.header),
  );
  const [selected, setSelected] = useState(firstSelectable);

  const step = (direction: number) => {
    setSelected((current) => {
      let next = current;
      for (let i = 0; i < items.length; i++) {
        next = (next + direction + items.length) % items.length;
        if (!items[next].header) {
          return next;
        }
      }
      return current;
    });
  };

  useInput((_in, key) => {
    if (key.upArrow) {
      step(-1);
    } else if (key.downArrow) {
      step(1);
    } else if (key.return && items[selected] && !items[selected].header) {
      onSelect(items[selected].value as T);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {label}
      </Text>
      <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
        {items.map((item, index) =>
          item.header ? (
            <Text key={index} color={theme.mute} bold>
              {"  "}
              {item.label}
            </Text>
          ) : (
            <Text key={index}>
              {index === selected ? (
                <Text color={theme.brand} bold>
                  ▸{" "}
                </Text>
              ) : (
                <Text>{"  "}</Text>
              )}
              <Text
                color={index === selected ? theme.info : undefined}
                bold={index === selected}
              >
                {item.label}
              </Text>
            </Text>
          ),
        )}
        {!items.length && <Text dimColor>(none)</Text>}
      </Box>
      <Text dimColor> ↑/↓ move · ↵ select · esc back</Text>
    </Box>
  );
}

// A single-line editor with a caret, an optional inline completion (⇥ accepts), and an optional
// placeholder that → fills into the field.
// `isActive: false` parks the field: it still renders, dimmed, but takes no keys — which is how a form
// can mount several at once and still honour the one-keyboard-owner rule above.
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
  const completionSuffix =
    completion && completion.length > value.length && completion.startsWith(value)
      ? completion.slice(value.length)
      : "";

  const update = (nextValue: string, nextCaret?: number) => {
    setCompletionIdle(false);
    setValue(nextValue);
    setCaret(
      Math.max(0, Math.min(nextValue.length, nextCaret ?? nextValue.length)),
    );
    onChange?.(nextValue);
  };

  useEffect(() => {
    if (!complete || !isActive) {
      return;
    }
    const timer = setTimeout(
      () => setCompletionIdle(true),
      COMPLETION_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [value, complete, isActive]);

  useInput((input, key) => {
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
        update(
          value.slice(0, caret - 1) + value.slice(caret),
          caret - 1,
        );
      }
    } else if (input && !key.ctrl && !key.meta) {
      update(
        value.slice(0, caret) + input + value.slice(caret),
        caret + input.length,
      );
    }
  }, { isActive });

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
      <Box
        borderStyle="round"
        borderColor={isActive ? theme.brand : theme.mute}
        paddingX={1}
      >
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
          {completionSuffix
            ? `    ⇥ tab → ${completion}`
            : value === "" && placeholder
              ? "    → fill template · ↵ submit"
              : "    ↵ submit"}{" "}
          esc back
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
