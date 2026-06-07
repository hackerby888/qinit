import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "@qinit/core";
import { killNode, nodeAlive } from "../node-ops";
import { Header, Status, Spinner, KV, theme } from "../ui";

// qinit clean [--dry-run]
// Remove ALL qinit cache (~/.cache/qinit or $QINIT_CACHE): the fetched node, core-headers, wasi-sdk/clang,
// verify tools, and the scratch run dir. Everything here is re-fetched on the next `qinit up` — safe to wipe.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const a of args) if (a.startsWith("--")) o[a.slice(2)] = "";
  return o;
}
function dirSize(p: string): number {
  let s = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const fp = join(p, e.name);
    try { s += e.isDirectory() ? dirSize(fp) : statSync(fp).size; } catch {}
  }
  return s;
}
const human = (n: number) => (n < 1024 ? n + "B" : n < 1048576 ? Math.round(n / 1024) + "KB" : (n / 1048576).toFixed(1) + "MB");

type S = { phase: "run" | "empty" | "done" | "err"; items?: { name: string; sz: number }[]; total?: number; killed?: boolean; err?: string };

export function Clean({ args }: { args: string[] }) {
  const o = parse(args);
  const dry = o["dry-run"] !== undefined;
  const root = cacheRoot();
  const { exit } = useApp();
  const [s, setS] = useState<S>({ phase: "run" });

  useEffect(() => {
    (async () => {
      try {
        if (!existsSync(root)) { setS({ phase: "empty" }); return; }
        let killed = false;
        if (nodeAlive()) { await killNode(); killed = true; }   // a running node holds locks under <cache>/run
        const items = readdirSync(root).map((name) => {
          const p = join(root, name);
          let sz = 0; try { sz = statSync(p).isDirectory() ? dirSize(p) : statSync(p).size; } catch {}
          return { name, sz };
        }).sort((a, b) => b.sz - a.sz);
        const total = items.reduce((a, e) => a + e.sz, 0);
        if (!dry) rmSync(root, { recursive: true, force: true });
        setS({ phase: "done", items, total, killed });
      } catch (e: any) { setS({ phase: "err", err: String(e?.message ?? e) }); }
    })();
  }, []);
  useEffect(() => { if (s.phase !== "run") { const t = setTimeout(() => exit(), 20); return () => clearTimeout(t); } }, [s.phase]);

  return (
    <Box flexDirection="column">
      <Header cmd="clean" />
      <Text dimColor>{root}</Text>
      {s.phase === "run" && <Spinner label={dry ? "scanning cache" : "clearing cache"} />}
      {s.phase === "empty" && <Text dimColor>cache already empty — nothing to remove</Text>}
      {s.phase === "err" && <Text color={theme.err}>ERROR: {s.err}</Text>}
      {s.phase === "done" && (
        <Box flexDirection="column">
          <Status ok={dry ? null : true} label={dry ? `would free ${human(s.total!)}` : `freed ${human(s.total!)}`} />
          {s.items!.length ? <Box marginLeft={2}><KV rows={s.items!.map((i) => [i.name, human(i.sz)])} /></Box> : null}
          {s.killed ? <Text dimColor>(stopped a running node first)</Text> : null}
          <Box marginTop={1}><Text dimColor>re-fetched on next </Text><Text bold color={theme.accent}>qinit up</Text></Box>
        </Box>
      )}
    </Box>
  );
}
