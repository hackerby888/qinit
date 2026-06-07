import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc } from "@qinit/core";
import { readState, type StateDump } from "../trace-format";
import { StateView } from "../views";
import { loadConfig } from "../config";
import { Header, Spinner, theme } from "../ui";

// qinit state <name|slot> [--rpc <url>]
// Decode + print a deployed contract's CURRENT state: scalar fields (named, decoded) + container contents.
// Reuses the debugger's field/container decoders (trace-format), driven by the node-stored contract source.
function parse(args: string[]): { target: string; rpc?: string } {
  let target = ""; let rpc: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rpc") rpc = args[++i];
    else if (!a.startsWith("--") && !target) target = a;
  }
  return { target, rpc };
}

export function State({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [dump, setDump] = useState<StateDump | null>(null);
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  const add = (s: string) => setLines((l) => [...l, s]);

  useEffect(() => {
    (async () => {
      try {
        if (!o.target) throw new Error("usage: qinit state <name|slot>");
        const rpc = new LiteRpc(rpcBase);
        const reg = await rpc.dynRegistry();
        const c = (reg.contracts ?? []).find((x) => String(x.index) === o.target || (x.name || "").toLowerCase() === o.target.toLowerCase());
        if (!c) throw new Error(`no deployed contract '${o.target}'`);
        if (!c.source) throw new Error(`node has no source for slot ${c.index} — cannot decode state`);
        setName(c.name || String(c.index));
        setDump(await readState(rpc, c.index, c.source, c.name || "Contract"));
      } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); }
      setDone(true);
    })();
  }, []);
  useEffect(() => { if (done) { const t = setTimeout(() => exit(), 50); return () => clearTimeout(t); } }, [done]);

  return (
    <Box flexDirection="column">
      <Header cmd="state" />
      {lines.map((l, i) => <Text key={i} color={l.startsWith("ERROR") ? theme.err : undefined}>{l}</Text>)}
      {dump ? <StateView name={name} dump={dump} /> : (!done ? <Spinner label="reading state" /> : null)}
    </Box>
  );
}
