import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { cacheRoot } from "@qinit/core";
import { cacheInfo, wipeCache, human, type CacheItem } from "../cache-ops";
import { Header, Status, Spinner, KV, theme } from "../ui";
import { parseArgs } from "../args";

// qinit clean [--dry-run]
// Remove ALL qinit cache (~/.cache/qinit or $QINIT_CACHE): fetched node, core-headers, wasi-sdk/clang artifacts.
type S = {
  phase: "run" | "empty" | "done" | "err";
  items?: CacheItem[];
  total?: number;
  killed?: boolean;
  err?: string;
};

export function Clean({ args }: { args: string[] }) {
  const { flags: o } = parseArgs(args, { booleans: ["dry-run"] });
  const dry = o["dry-run"] !== undefined;
  const root = cacheRoot();
  const { exit } = useApp();
  const [s, setS] = useState<S>({ phase: "run" });

  useEffect(() => {
    (async () => {
      try {
        if (dry) {
          const info = cacheInfo();
          setS(
            info.exists
              ? { phase: "done", items: info.items, total: info.total, killed: false }
              : { phase: "empty" },
          );
          return;
        }
        const w = await wipeCache();
        setS(
          w.exists
            ? { phase: "done", items: w.items, total: w.total, killed: w.killed }
            : { phase: "empty" },
        );
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
      <Header cmd="clean" />
      <Text dimColor>{root}</Text>
      {s.phase === "run" && <Spinner label={dry ? "scanning cache" : "clearing cache"} />}
      {s.phase === "empty" && <Text dimColor>cache already empty — nothing to remove</Text>}
      {s.phase === "err" && <Text color={theme.err}>ERROR: {s.err}</Text>}
      {s.phase === "done" && (
        <Box flexDirection="column">
          <Status
            ok={dry ? null : true}
            label={dry ? `would free ${human(s.total!)}` : `freed ${human(s.total!)}`}
          />
          {s.items!.length ? (
            <Box marginLeft={2}>
              <KV rows={s.items!.map((i) => [i.name, human(i.sz)])} />
            </Box>
          ) : null}
          {s.killed ? <Text dimColor>(stopped a running node first)</Text> : null}
          <Box marginTop={1}>
            <Text dimColor>re-fetched on next </Text>
            <Text bold color={theme.accent}>
              qinit setup
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
