import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc } from "@qinit/core";
import { callFunction, invokeProcedure } from "@qinit/proto";
import { CallInteractive } from "./call-interactive";
import { loadConfig } from "../config";

// Non-interactive forms (qubic-cli style):
//   qinit call --fn   <idx> <fnId>   --in "<fmt>" --out "<fmt>"
//   qinit call --proc <idx> <procId> --amount N --in "<fmt>" --seed <55>
// No --fn/--proc  -> interactive picker driven by the node's dyn-registry.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fn" || a === "--proc") { o.mode = a.slice(2); o.idx = args[++i]; o.entry = args[++i]; }
    else if (a.startsWith("--")) {
      const next = args[i + 1];
      o[a.slice(2)] = next === undefined || next.startsWith("--") ? "" : args[++i];
    }
  }
  return o;
}

export function Call({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  if (o.mode !== "fn" && o.mode !== "proc") return <CallInteractive rpcBase={rpcBase} seed={o.seed} />;
  return <CallOneShot o={o} rpcBase={rpcBase} />;
}

function CallOneShot({ o, rpcBase }: { o: Record<string, string>; rpcBase: string }) {
  const { exit } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBase);
        const idx = Number(o.idx);
        const entry = Number(o.entry);
        if (o.mode === "fn") {
          const out = await callFunction(rpc, idx, entry, o.in ?? "", o.out ?? "");
          add(`fn ${idx}/${entry} -> ${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        } else {
          const ti: any = await rpc.tickInfo();
          const tick = (ti.tick ?? ti.currentTick ?? 0) + 8;
          const r = await invokeProcedure({
            seed: o.seed ?? "a".repeat(55), rpcBase, contractIndex: idx, procId: entry,
            amount: Number(o.amount ?? 0), inFmt: o.in ?? "", tick,
          });
          add(`proc ${idx}/${entry} @tick ${tick}: ${r.ok ? "ok " + (r.txId ?? "").slice(0, 16) : "FAIL code=" + r.code + " " + (r.message ?? "")}`);
        }
        setDone(true);
      } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); setDone(true); }
    })();
  }, []);
  useEffect(() => { if (done) exit(); }, [done]);

  return <Box flexDirection="column">{log.map((l, i) => <Text key={i}>{l}</Text>)}{!done && <Text dimColor>…</Text>}</Box>;
}
