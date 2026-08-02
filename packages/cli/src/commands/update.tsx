import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { Header, Status, Spinner, Bar, theme } from "../ui";
import type { CommandArguments } from "../args";
import { runSelfUpdate, type SelfUpdateResult } from "../update-ops";

type UpdateState =
  | { phase: "running" }
  | SelfUpdateResult
  | { phase: "error"; message: string };

export function Update({ commandArgs }: { commandArgs: CommandArguments }) {
  const force = commandArgs.has("force"),
    dry = commandArgs.has("dry-run");
  const { exit } = useApp();
  const [state, setState] = useState<UpdateState>({ phase: "running" });
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    runSelfUpdate({
      force,
      dryRun: dry,
      onProgress: (received, total) => {
        if (total > 0) {
          setPct(received / total);
        }
      },
    }).then(setState, (error: unknown) => {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  useEffect(() => {
    if (state.phase === "running") {
      return;
    }
    process.exitCode = state.phase === "error" ? 1 : 0;
    const timer = setTimeout(() => exit(), 20);
    return () => clearTimeout(timer);
  }, [state.phase, exit]);

  return (
    <Box flexDirection="column">
      <Header cmd="self-update" />
      {state.phase === "running" &&
        (pct != null ? (
          <Text>
            <Bar pct={pct} /> <Text dimColor>downloading</Text>
          </Text>
        ) : (
          <Spinner label="checking for updates" />
        ))}
      {state.phase === "development" && (
        <Text color={theme.warn}>
          self-update only updates the installed binary — in dev, rebuild or use the installer
          (install.sh / install.ps1)
        </Text>
      )}
      {state.phase === "dry-run" && (
        <Box flexDirection="column">
          <Status
            ok={null}
            label={`latest ${state.tag}`}
            detail={`current v${state.currentVersion}`}
          />
          <Text dimColor> {state.asset}</Text>
        </Box>
      )}
      {state.phase === "up-to-date" && (
        <Status ok={true} label={`already on the latest (v${state.version})`} />
      )}
      {state.phase === "updated" && (
        <Box flexDirection="column">
          <Status
            ok={true}
            label={`updated v${state.previousVersion} → v${state.version}`}
          />
          <Box marginTop={1}>
            <Text dimColor>restart qinit to use the new version</Text>
          </Box>
        </Box>
      )}
      {state.phase === "error" && (
        <Text color={theme.err}>ERROR: {state.message}</Text>
      )}
    </Box>
  );
}
