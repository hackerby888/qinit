import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import type { SystemContract } from "@qinit/build";
import { loadConfig } from "../config";
import { loadSystem } from "../contracts";
import { Header, Spinner, Panel, Table, theme, type Column } from "../ui";
import { output } from "../args";

// qinit ls [--rpc <url>]  — user-deployed contracts (dyn-registry) first, then built-in system contracts (catalog).
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}
const COLS: Column[] = [
  { header: "slot", align: "right" }, { header: "name", max: 20 }, { header: "state" },
  { header: "fn·proc", align: "right" }, { header: "ver", align: "right" }, { header: "k12", dim: true, max: 16 },
];
const SYS_COLS: Column[] = [
  { header: "idx", align: "right" }, { header: "name", max: 16 }, { header: "fn·proc", align: "right" }, { header: "source", dim: true, max: 24 },
];
const stateOf = (c: DynContract) => (!c.armed ? "empty" : c.constructed ? "ready" : "constructing");

export function Ls({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [s, setS] = useState<{ phase: "run" | "done"; user?: DynContract[]; system?: SystemContract[]; nodeDown?: boolean }>({ phase: "run" });

  useEffect(() => { (async () => {
    let user: DynContract[] = []; let nodeDown = false;
    try { user = (await new LiteRpc(rpcBase).dynRegistry()).contracts ?? []; } catch { nodeDown = true; }
    setS({ phase: "done", user, system: loadSystem(), nodeDown });   // system from the snapshot — shows even if the node is down
  })(); }, []);
  useEffect(() => { if (s.phase !== "run") {
    if (output.json) process.stdout.write(JSON.stringify({
      deployed: (s.user ?? []).map((c) => ({ slot: c.index, name: c.name || null, state: stateOf(c), version: c.version ?? 0, codeHash: c.codeHash || null })),
      system: (s.system ?? []).map((c) => ({ index: c.index, name: c.name, file: c.file })),
      nodeDown: !!s.nodeDown,
    }) + "\n");
    const t = setTimeout(() => exit(), 20); return () => clearTimeout(t);
  } }, [s.phase]);

  if (output.json) return null;
  if (s.phase === "run") return <Box flexDirection="column"><Header cmd="ls" /><Spinner label="loading contracts" /></Box>;

  const user = (s.user ?? []).filter((c) => c.armed || (c.name && c.name.length));
  const system = s.system ?? [];
  return (
    <Box flexDirection="column">
      <Header cmd="ls" />
      {user.length > 0 && (
        <Panel title={`deployed · ${user.length}`} color={theme.brand}>
          <Table columns={COLS}
            rows={user.map((c) => [String(c.index), c.name || "-", stateOf(c), `${c.functions?.length ?? 0}/${c.procedures?.length ?? 0}`, "v" + (c.version ?? 0), (c.codeHash || "").slice(0, 16) + "…"])}
            rowColor={(i) => { const st = stateOf(user[i]); return st === "constructing" ? theme.warn : st === "empty" ? theme.mute : undefined; }} />
        </Panel>
      )}
      {system.length > 0 && (
        <Panel title={`system · ${system.length}`} color={theme.info}>
          <Table columns={SYS_COLS}
            rows={system.map((c) => [String(c.index), c.name, `${Object.keys(c.idl.functions).length}/${Object.keys(c.idl.procedures).length}`, c.file])} />
        </Panel>
      )}
      {user.length === 0 && (s.nodeDown
        ? <Text dimColor>node unreachable — deployed contracts hidden. <Text bold color={theme.accent}>qinit up</Text> to start it.</Text>
        : system.length === 0
          ? <Text dimColor>no contracts — <Text bold color={theme.accent}>qinit deploy</Text>, or <Text bold color={theme.accent}>qinit up</Text> for system contracts</Text>
          : null)}
    </Box>
  );
}
