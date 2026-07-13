import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { existsSync, unlinkSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { cacheInfo, wipeCache, human } from "../cache-ops";
import { Header, Status, Spinner, KV, theme } from "../ui";

// qinit uninstall [--yes] [--keep-cache] [--dry-run]
// Remove the qinit binary AND its cache/data. Bare run = preview only; --yes actually removes.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const a of args) if (a.startsWith("--")) o[a.slice(2)] = "";
  return o;
}
const isWin = process.platform === "win32";
// the running exe (unless dev: bun/node) + the canonical install path, de-duped.
function binTargets(): string[] {
  const out: string[] = [];
  const self = process.execPath;
  if (basename(self) !== "bun" && basename(self) !== "node") out.push(self);
  // canonical install dir: install.ps1 -> %LOCALAPPDATA%\qinit\bin (qinit.exe); install.sh -> ~/.local/bin (qinit)
  const dir =
    process.env.QINIT_BIN ||
    (isWin
      ? join(process.env.LOCALAPPDATA || homedir(), "qinit", "bin")
      : join(homedir(), ".local", "bin"));
  const installed = join(dir, isWin ? "qinit.exe" : "qinit");
  if (existsSync(installed)) out.push(installed);
  return out.filter((p, i, a) => a.indexOf(p) === i);
}
type S = {
  phase: "run" | "preview" | "done" | "err";
  bins?: string[];
  cacheTotal?: number;
  freed?: number;
  killed?: boolean;
  removed?: string[];
  err?: string;
};

export function Uninstall({ args }: { args: string[] }) {
  const o = parse(args);
  const go = o.yes !== undefined && o["dry-run"] === undefined;
  const keepCache = o["keep-cache"] !== undefined;
  const { exit } = useApp();
  const [s, setS] = useState<S>({ phase: "run" });

  useEffect(() => {
    (async () => {
      try {
        const bins = binTargets();
        if (!go) {
          setS({ phase: "preview", bins, cacheTotal: cacheInfo().total });
          return;
        }
        let freed = 0,
          killed = false;
        if (!keepCache) {
          const w = await wipeCache();
          freed = w.total;
          killed = w.killed;
        }
        const removed: string[] = [];
        for (const b of bins) {
          try {
            unlinkSync(b);
            removed.push(b);
          } catch {
            // running exe is unlinkable on linux/macOS
            if (isWin) {
              try {
                renameSync(b, b + ".old");
                removed.push(b);
              } catch {}
            }
          } // Windows locks a running .exe -> rename aside so PATH no longer resolves qinit
        }
        setS({ phase: "done", bins, removed, freed, killed });
      } catch (e: any) {
        setS({ phase: "err", err: String(e?.message ?? e) });
      }
    })();
  }, []);
  useEffect(() => {
    if (s.phase !== "run") {
      const t = setTimeout(() => exit(), 20);
      return () => clearTimeout(t);
    }
  }, [s.phase]);

  return (
    <Box flexDirection="column">
      <Header cmd="uninstall" />
      {s.phase === "run" && <Spinner label="removing" />}
      {s.phase === "err" && <Text color={theme.err}>ERROR: {s.err}</Text>}
      {s.phase === "preview" && (
        <Box flexDirection="column">
          <Status ok={null} label="would remove" />
          <Box marginLeft={2}>
            <KV
              rows={[
                ...s.bins!.map((b) => ["binary", b] as [string, string]),
                [
                  "cache",
                  keepCache
                    ? "(kept — --keep-cache)"
                    : `${cacheInfo().root}  ${human(s.cacheTotal!)}`,
                ],
              ]}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>re-run to confirm: </Text>
            <Text bold color={theme.accent}>
              qinit uninstall --yes
            </Text>
          </Box>
        </Box>
      )}
      {s.phase === "done" && (
        <Box flexDirection="column">
          <Status
            ok={true}
            label={`uninstalled${keepCache ? " (cache kept)" : ` · freed ${human(s.freed!)}`}`}
          />
          {s.removed!.length ? (
            <Box marginLeft={2} flexDirection="column">
              {s.removed!.map((b, i) => (
                <Text key={i} dimColor>
                  removed {b}
                </Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>(no binary path found to remove)</Text>
          )}
          {s.killed ? <Text dimColor>(stopped a running node first)</Text> : null}
          <Box marginTop={1}>
            <Text dimColor>thanks for using qinit · reinstall: </Text>
            <Text bold color={theme.accent}>
              curl -fsSL …/install.sh | sh
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
