import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { VERSION } from "../version";
import { Banner, Header, theme } from "../ui";
import { META, GROUP_ORDER, COMMANDS, type Flag, type CommandMeta } from "../meta";

// Global help — grouped by workflow stage (from meta.ts) so it reads top-to-bottom as you'd use qinit.
export function Help({ unknown, command, suggestion }: { unknown?: boolean; command?: string; suggestion?: string }) {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  const w = Math.max(...COMMANDS.map((c) => c.length)) + 2; // align descriptions across all groups
  const pad = "  " + " ".repeat(w); // indent for example/note lines
  const groups = GROUP_ORDER.map((g) => ({ title: g, items: COMMANDS.filter((c) => META[c].group === g) }));
  return (
    <Box flexDirection="column">
      {unknown && (
        <Box marginBottom={1} flexDirection="column">
          <Text><Text color={theme.warn}>✗ unknown command:</Text> <Text bold>{command}</Text></Text>
          {suggestion && <Text>{"  "}<Text dimColor>did you mean</Text> <Text bold color={theme.accent}>{suggestion}</Text><Text dimColor>?</Text></Text>}
        </Box>
      )}
      <Banner version={VERSION} tagline="Framework for Qubic dynamic contracts" />
      <Text dimColor>usage: <Text color={theme.info}>qinit</Text> &lt;command&gt; [args]   ·   <Text color={theme.info}>qinit &lt;command&gt; --help</Text> for a command's flags</Text>
      {groups.map((g) => (
        <Box key={g.title} marginTop={1} flexDirection="column">
          <Text bold color={theme.brand}>{g.title}</Text>
          {g.items.map((name) => {
            const m = META[name];
            return (
              <Box key={name} flexDirection="column">
                <Text>{"  "}<Text bold color={theme.accent}>{name.padEnd(w)}</Text><Text dimColor>{m.summary}</Text></Text>
                {m.examples?.map((line, i) => (
                  <Text key={i}>{pad}{line.startsWith("qinit ") ? <Text color={theme.info}>{line}</Text> : <Text dimColor>{line}</Text>}</Text>
                ))}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

// Per-command help — `qinit <cmd> --help`: summary + usage line + flags table + examples.
export function Usage({ cmd }: { cmd: string }) {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  const m: CommandMeta | undefined = META[cmd];
  if (!m) return <Help unknown command={cmd} />;
  const flags: Flag[] = [...(m.flags ?? [])];
  if (m.json) flags.push(["--json", "emit a machine-readable result (implies --plain)"]);
  const fw = flags.length ? Math.max(...flags.map(([f]) => f.length)) + 2 : 0;
  return (
    <Box flexDirection="column">
      <Header cmd={cmd} />
      <Text dimColor>{m.summary}</Text>
      <Box marginTop={1}>
        <Text dimColor>usage: </Text>
        <Text color={theme.info}>qinit {cmd}{m.usage ? " " + m.usage : ""}</Text>
      </Box>
      {flags.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.brand}>flags</Text>
          {flags.map(([f, d], i) => (
            <Text key={i}>{"  "}<Text color={theme.accent}>{f.padEnd(fw)}</Text><Text dimColor>{d}</Text></Text>
          ))}
        </Box>
      ) : null}
      {m.examples?.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.brand}>examples</Text>
          {m.examples.map((line, i) => (
            <Text key={i}>{"  "}{line.startsWith("qinit ") ? <Text color={theme.info}>{line}</Text> : <Text dimColor>{line}</Text>}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
