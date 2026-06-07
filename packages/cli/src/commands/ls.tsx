import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import { loadConfig } from "../config";
import { Header, Spinner, theme } from "../ui";

// qinit ls [--rpc <url>]  — list contracts deployed on the node (from the dyn-registry).
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length));

export function Ls({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [s, setS] = useState<{ phase: "run" | "done" | "err"; rows?: DynContract[]; err?: string }>({ phase: "run" });

  useEffect(() => { (async () => {
    try { const reg = await new LiteRpc(rpcBase).dynRegistry(); setS({ phase: "done", rows: reg.contracts ?? [] }); }
    catch (e: any) { setS({ phase: "err", err: String(e?.message ?? e) }); }
  })(); }, []);
  useEffect(() => { if (s.phase !== "run") { const t = setTimeout(() => exit(), 20); return () => clearTimeout(t); } }, [s.phase]);

  if (s.phase === "run") return <Box flexDirection="column"><Header cmd="ls" /><Spinner label="loading dyn-registry" /></Box>;
  if (s.phase === "err") return <Box flexDirection="column"><Header cmd="ls" /><Text color={theme.err}>ERROR: {s.err}</Text></Box>;

  const rows = (s.rows ?? []).filter((c) => c.armed || (c.name && c.name.length));
  return (
    <Box flexDirection="column">
      <Header cmd="ls" />
      {rows.length === 0 ? <Text dimColor>no contracts deployed</Text> : (
        <Box flexDirection="column">
          <Text bold>{pad("slot", 5)}{pad("name", 18)}{pad("state", 14)}{pad("fn/proc", 9)}{pad("ver", 5)}k12</Text>
          {rows.map((c) => {
            const state = !c.armed ? "empty" : c.constructed ? "ready" : "constructing";
            const col = state === "ready" ? theme.ok : state === "constructing" ? theme.warn : undefined;
            return (
              <Text key={c.index}>
                {pad(String(c.index), 5)}{pad(c.name || "-", 18)}
                <Text color={col}>{pad(state, 14)}</Text>
                {pad(`${c.functions?.length ?? 0}/${c.procedures?.length ?? 0}`, 9)}{pad("v" + (c.version ?? 0), 5)}
                <Text dimColor>{(c.codeHash || "").slice(0, 16)}</Text>
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
