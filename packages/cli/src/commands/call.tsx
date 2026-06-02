import { useEffect, useState } from "react";
import { readFileSync, existsSync } from "node:fs";
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
        const idl: any = (() => { try { return existsSync("qinit.idl.json") ? JSON.parse(readFileSync("qinit.idl.json", "utf8")) : {}; } catch { return {}; } })();

        // contract: accept a name (resolve via registry) or a slot index.
        let idx = Number(o.idx);
        if (Number.isNaN(idx)) {
          const reg = await rpc.dynRegistry();
          const c = (reg.contracts ?? []).find((x) => x.armed && (x.name || "").toLowerCase() === String(o.idx).toLowerCase());
          if (!c) throw new Error(`no deployed contract named '${o.idx}'`);
          idx = c.index;
        }
        // entry: accept a fn/proc name (resolve via IDL) or an inputType number.
        const tbl = (o.mode === "fn" ? idl[String(idx)]?.functions : idl[String(idx)]?.procedures) ?? {};
        let entry = Number(o.entry);
        let ie: any = tbl[String(entry)];
        if (Number.isNaN(entry)) {
          const hit = Object.entries(tbl).find(([, e]: any) => (e.name || "").toLowerCase() === String(o.entry).toLowerCase());
          if (!hit) throw new Error(`no ${o.mode} named '${o.entry}' on contract ${idx} (build/deploy to populate IDL)`);
          entry = Number(hit[0]); ie = hit[1];
        }
        const inFmt = o.in ?? ie?.in ?? "";

        if (o.mode === "fn") {
          const out = await callFunction(rpc, idx, entry, inFmt, o.out ?? ie?.out ?? "");
          add(`fn ${idx}/${entry} -> ${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        } else {
          const ti: any = await rpc.tickInfo();
          const tick = (ti.tick ?? ti.currentTick ?? 0) + 8;
          const r = await invokeProcedure({
            seed: o.seed ?? "a".repeat(55), rpcBase, contractIndex: idx, procId: entry,
            amount: Number(o.amount ?? 0), inFmt, tick,
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
