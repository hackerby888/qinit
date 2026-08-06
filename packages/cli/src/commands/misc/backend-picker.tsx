import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { CommandArguments } from "../../args";
import { GradLine, Header, theme } from "../../ui";

export function BackendPicker<Backend extends string>({
  commandArgs,
  command,
  label,
  backends,
  descriptions,
  current,
  width,
  save,
}: {
  commandArgs: CommandArguments;
  command: "compiler" | "node-backend";
  label: string;
  backends: readonly Backend[];
  descriptions: Record<Backend, string>;
  current: Backend;
  width: number;
  save: (backend: Backend) => void;
}) {
  const requested = commandArgs.positionals[0];
  const show = commandArgs.has("show");
  const { exit } = useApp();
  const [selection, setSelection] = useState(
    Math.max(0, backends.indexOf(current)),
  );
  const selectionRef = useRef(selection);
  const [messages, setMessages] = useState<string[]>([]);
  const [phase, setPhase] = useState<"pick" | "done">(
    requested || show ? "done" : "pick",
  );

  const add = (message: string) => {
    setMessages((currentMessages) => [...currentMessages, message]);
  };
  const move = (offset: number) => {
    selectionRef.current =
      (selectionRef.current + offset + backends.length) % backends.length;
    setSelection(selectionRef.current);
  };

  useEffect(() => {
    if (show) {
      add(`active ${label}: ${current}`);
      return;
    }
    if (!requested) {
      return;
    }
    if (!backends.includes(requested as Backend)) {
      add(`✗ unknown ${label} '${requested}' — pick: ${backends.join(", ")}`);
      return;
    }
    save(requested as Backend);
    add(`✓ ${label} set: ${requested}`);
  }, []);

  useEffect(() => {
    if (phase === "done") {
      const timer = setTimeout(() => exit(), 30);
      return () => clearTimeout(timer);
    }
  }, [phase, exit]);

  useInput(
    (input, key) => {
      if (phase !== "pick") {
        return;
      }
      if (input === "q" || key.escape) {
        exit();
      } else if (key.upArrow) {
        move(-1);
      } else if (key.downArrow) {
        move(1);
      } else if (key.return) {
        const backend = backends[selectionRef.current];
        save(backend);
        add(`✓ ${label} saved: ${backend}`);
        setPhase("done");
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  return (
    <Box flexDirection="column">
      <Header cmd={command} />
      {phase === "done" &&
        messages.map((message, index) => (
          <Text
            key={index}
            color={message.startsWith("✗") ? theme.err : theme.ok}
          >
            {message}
          </Text>
        ))}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ save · q cancel</Text>
          <Box
            borderStyle="round"
            borderColor={theme.brand}
            paddingX={1}
            flexDirection="column"
          >
            {backends.map((backend, index) => {
              const selected = index === selection;
              return (
                <Text key={backend}>
                  {selected ? (
                    <GradLine text={`▸ ${backend.padEnd(width)}`} />
                  ) : (
                    <Text>
                      {"  "}
                      <Text color={theme.brand}>{backend.padEnd(width)}</Text>
                    </Text>
                  )}
                  <Text dimColor> {descriptions[backend]}</Text>
                  {backend === current ? (
                    <Text color={theme.ok}> ✓ current</Text>
                  ) : null}
                </Text>
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
