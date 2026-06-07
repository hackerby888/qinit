import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import { loadConfig } from "../config";
import { Header, Spinner, Panel, Table, theme, type Column } from "../ui";

// qinit ls [--rpc <url>]  — list contracts deployed on the node (from the dyn-registry).
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}
const COLS: Column[] = [
  { header: "slot", align: "right" }, { header: "name", max: 20 }, { header: "state" },
  { header: "fn·proc", align: "right" }, { header: "ver", align: "right" }, { header: "k12", dim: true, max: 16 },
];
const stateOf = (c: DynContract) => (!c.armed ? "empty" : c.constructed ? "ready" : "constructing");

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
      {rows.length === 0 ? <Text dimColor>no contracts deployed — try: <Text bold color={theme.accent}>qinit deploy</Text></Text> : (
        <Panel title={`contracts · ${rows.length}`} color={theme.brand}>
          <Table
            columns={COLS}
            rows={rows.map((c) => [String(c.index), c.name || "-", stateOf(c), `${c.functions?.length ?? 0}/${c.procedures?.length ?? 0}`, "v" + (c.version ?? 0), (c.codeHash || "").slice(0, 16) + "…"])}
            rowColor={(i) => { const st = stateOf(rows[i]); return st === "constructing" ? theme.warn : st === "empty" ? theme.mute : undefined; }}
          />
        </Panel>
      )}
    </Box>
  );
}
