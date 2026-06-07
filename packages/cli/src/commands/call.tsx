import { useEffect, useState } from "react";
import { readFileSync, existsSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { LiteRpc } from "@qinit/core";
import { callFunction, invokeProcedure } from "@qinit/proto";
import { extractIdl } from "@qinit/build";
import { CallInteractive } from "./call-interactive";
import { loadConfig } from "../config";
import { Header, Spinner, theme } from "../ui";

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
  const [status, setStatus] = useState("");
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
        // entry: accept a fn/proc name (resolve via IDL) or an inputType number. Prefer the local
        // qinit.idl.json; if absent for this slot, derive the IDL from the node-stored contract source
        // (dyn-registry) so a name call works for any deployed contract, not just locally-built ones.
        let tbl: any = (o.mode === "fn" ? idl[String(idx)]?.functions : idl[String(idx)]?.procedures);
        if (!tbl || !Object.keys(tbl).length) {
          try {
            const reg = await rpc.dynRegistry();
            const c = (reg.contracts ?? []).find((x) => x.index === idx);
            if (c?.source) { const d = extractIdl(c.source, c.name || "Contract"); tbl = o.mode === "fn" ? d.functions : d.procedures; }
          } catch {}
        }
        tbl = tbl ?? {};
        let entry = Number(o.entry);
        let ie: any = tbl[String(entry)];
        if (Number.isNaN(entry)) {
          const hit = Object.entries(tbl).find(([, e]: any) => (e.name || "").toLowerCase() === String(o.entry).toLowerCase());
          if (!hit) throw new Error(`no ${o.mode} named '${o.entry}' on contract ${idx} (no local IDL and node has no source for this slot)`);
          entry = Number(hit[0]); ie = hit[1];
        }
        const inFmt = o.in ?? ie?.in ?? "";

        // node-side runtime error: the most recent dispatch trap on this slot (dyn-registry lastError),
        // so a contract that traps shows WHY here instead of only in the node console.
        const nodeErr = async (): Promise<string> => {
          try { const reg = await rpc.dynRegistry(); const c = (reg.contracts ?? []).find((x) => x.index === idx); return c?.lastError ? ` · contract error: ${c.lastError}` : ""; } catch { return ""; }
        };

        if (o.mode === "fn") {
          const out = await callFunction(rpc, idx, entry, inFmt, o.out ?? ie?.out ?? "");
          const ne = (out == null || (typeof out === "object" && Object.keys(out).length === 0)) ? await nodeErr() : "";
          add(`fn ${idx}/${entry} -> ${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}${ne}`);
        } else {
          const ti: any = await rpc.tickInfo();
          const tick = (ti.tick ?? ti.currentTick ?? 0) + 8;
          const settle = o["no-settle"] === undefined;   // default: wait until the proc actually ran; --no-settle to skip
          const r = await invokeProcedure({
            seed: o.seed ?? (await rpc.fundedSeed()) ?? "a".repeat(55), rpcBase, contractIndex: idx, procId: entry,
            amount: Number(o.amount ?? 0), inFmt, tick, confirm: settle, rpc,
            onProgress: ({ tick: net, target }) =>
              setStatus(`confirming · network tick ${net} → target ${target}` + (net < target ? ` (${target - net} to go)` : " · processing")),
          });
          setStatus("");
          const txs = (r.txId ?? "").slice(0, 16);
          if (!r.ok) add(`proc ${idx}/${entry} @tick ${tick}: FAIL code=${r.code} ${r.message ?? ""}${await nodeErr()}`);
          else if (!settle) add(`proc ${idx}/${entry} @tick ${tick}: ok ${txs} (broadcast)`);
          else if (r.confirmed && r.included) add(`proc ${idx}/${entry} @tick ${tick}: ok · processed ${txs}${await nodeErr()}`);
          else if (r.confirmed && !r.included) add(`proc ${idx}/${entry} @tick ${tick}: DROPPED — not included ${txs}${await nodeErr()}`);
          else add(`proc ${idx}/${entry} @tick ${tick}: ok ${txs} (broadcast; unconfirmed — no tx-status addon or timed out)${await nodeErr()}`);
        }
        setDone(true);
      } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); setDone(true); }
    })();
  }, []);
  useEffect(() => { if (done) exit(); }, [done]);

  return (
    <Box flexDirection="column">
      <Header cmd="call" />
      {log.map((l, i) => (
        <Text key={i} color={l.startsWith("ERROR") || l.includes("FAIL") || l.includes("DROPPED") ? theme.err : l.includes("->") || l.includes(": ok") ? theme.ok : undefined}>{l}</Text>
      ))}
      {!done && <Spinner label={status || "calling"} />}
    </Box>
  );
}
