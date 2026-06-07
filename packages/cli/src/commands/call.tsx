import { useEffect, useState } from "react";
import { readFileSync, existsSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { LiteRpc, type DebugEntry } from "@qinit/core";
import { callFunction, invokeProcedure, jsonToInputFmt } from "@qinit/proto";
import { extractIdl } from "@qinit/build";
import { describeTrace, jstr, type TraceView as TraceData } from "../trace-format";
import { TraceView } from "../views";
import { CallInteractive } from "./call-interactive";
import { loadConfig } from "../config";
import { Header, Spinner, Status, Bar, theme } from "../ui";

type Result = { ok: boolean | null; label: string; detail?: string; rows?: [string, string][]; err?: string };
type Trace = { e: DebugEntry; name: string; view: TraceData };
type Confirm = { start: number; net: number; target: number };

// Non-interactive forms (qubic-cli style):
//   qinit call --fn   <idx> <fnId>   --in "<fmt>" --out "<fmt>"
//   qinit call --proc <idx> <procId> --amount N --in "<fmt>" --seed <55>
//   --args '<json>'  encode the input from a field-name JSON object (or positional array) via the IDL
//   --trace          after the call, print the captured debug trace (decoded I/O, state diff, logs, host-calls)
// No --fn/--proc  -> interactive picker driven by the node's dyn-registry.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  const [result, setResult] = useState<Result | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);

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
        // input: --args '<json>' (field-name keyed) encodes via the IDL field schema; else raw --in fmt; else
        // fall back to the IDL type fmt (only valid when the entry takes no input).
        let inFmt: string;
        if (o.args !== undefined) {
          const flds = ie?.inFields;
          if (!flds || !flds.length) throw new Error(`--args needs the input field schema for ${o.mode} ${idx}/${entry} (build/deploy locally, or the node must have the contract source)`);
          try { inFmt = jsonToInputFmt(flds, JSON.parse(o.args)); }
          catch (er: any) { throw new Error("--args: " + String(er?.message ?? er)); }
        } else inFmt = o.in ?? ie?.in ?? "";

        // --trace: capture the call in the node debug ring. Enable + note the latest seq BEFORE dispatch.
        const wantTrace = o.trace !== undefined;
        let sinceSeq = 0; let traceSrc: string | undefined; let traceName = String(idx);
        if (wantTrace) {
          try {
            await rpc.setDebug(true);
            const reg = await rpc.dynRegistry();
            const c = (reg.contracts ?? []).find((x) => x.index === idx);
            traceSrc = c?.source; traceName = c?.name || String(idx);
            sinceSeq = ((await rpc.debugTrace(0, 500)).entries ?? []).reduce((mx, en) => Math.max(mx, en.seq), 0);
          } catch {}
        }

        // node-side runtime error: the most recent dispatch trap on this slot (dyn-registry lastError).
        const nodeErr = async (): Promise<string> => {
          try { const reg = await rpc.dynRegistry(); const c = (reg.contracts ?? []).find((x) => x.index === idx); return c?.lastError ?? ""; } catch { return ""; }
        };
        const label = `${o.idx}.${ie?.name ?? (o.mode === "fn" ? "fn#" : "proc#") + entry}`;

        if (o.mode === "fn") {
          const out = await callFunction(rpc, idx, entry, inFmt, o.out ?? ie?.out ?? "");
          const empty = out == null || (typeof out === "object" && Object.keys(out).length === 0);
          const ne = empty ? await nodeErr() : "";
          setResult({ ok: ne ? false : true, label, rows: [["out", jstr(out)]], err: ne || undefined });
        } else {
          const ti: any = await rpc.tickInfo();
          const tick = (ti.tick ?? ti.currentTick ?? 0) + 8;
          const settle = o["no-settle"] === undefined;   // default: wait until the proc actually ran; --no-settle to skip
          const r = await invokeProcedure({
            seed: o.seed ?? (await rpc.fundedSeed()) ?? "a".repeat(55), rpcBase, contractIndex: idx, procId: entry,
            amount: Number(o.amount ?? 0), inFmt, tick, confirm: settle, rpc,
            onProgress: ({ tick: net, target }) => setConfirm((c) => ({ start: c?.start ?? net, net, target })),
          });
          setConfirm(null);
          const txs = (r.txId ?? "") || "—";   // full txid — user pastes it into the explorer
          const detail = !r.ok ? `FAIL${r.code != null ? " code=" + r.code : ""}` : !settle ? "broadcast"
            : r.confirmed && r.included ? "processed" : r.confirmed && !r.included ? "dropped — not included" : "broadcast · unconfirmed";
          const ok = !r.ok ? false : r.confirmed && !r.included ? false : true;
          setResult({ ok, label, detail, rows: [["tx", txs], ["tick", String(tick)]], err: (await nodeErr()) || (!r.ok ? r.message : undefined) });
        }

        if (wantTrace) {
          let te: DebugEntry | undefined;
          for (let i = 0; i < 12 && !te; i++) {
            const t = await rpc.debugTrace(sinceSeq, 200);
            te = (t.entries ?? []).filter((x) => x.index === idx && x.seq > sinceSeq && x.kind === (o.mode === "fn" ? 0 : 1) && x.entry === entry).pop();
            if (!te) await sleep(700);
          }
          if (te) setTrace({ e: te, name: traceName, view: await describeTrace(te, traceSrc, traceName, rpc) });
          else setNote("(no trace captured — is the debug toggle available on this node?)");
          try { await rpc.setDebug(false); } catch {}
        }
        setDone(true);
      } catch (e: any) { setResult({ ok: false, label: "call", err: String(e?.message ?? e) }); setDone(true); }
    })();
  }, []);
  useEffect(() => { if (done) exit(); }, [done]);

  const rw = Math.max(2, ...(result?.rows ?? []).map(([k]) => k.length));
  const pct = confirm && confirm.target > confirm.start ? (confirm.net - confirm.start) / (confirm.target - confirm.start) : 1;
  return (
    <Box flexDirection="column">
      <Header cmd="call" />
      {result && (
        <Box flexDirection="column">
          <Status ok={result.ok} label={result.label} detail={result.detail} pad={Math.max(14, result.label.length + 2)} />
          {result.rows?.length ? (
            <Box flexDirection="column" marginLeft={2}>
              {result.rows.map(([k, v], i) => <Text key={i}><Text color={theme.info}>{k.padEnd(rw)}</Text>  {v}</Text>)}
            </Box>
          ) : null}
          {result.err ? <Box marginLeft={2}><Text color={theme.err}>{result.err}</Text></Box> : null}
        </Box>
      )}
      {trace && <Box marginTop={1}><TraceView e={trace.e} name={trace.name} view={trace.view} /></Box>}
      {note && <Text dimColor>{note}</Text>}
      {!done && (confirm
        ? <Text><Bar pct={pct} /> <Text dimColor>tick {confirm.net}→{confirm.target}</Text></Text>
        : <Spinner label="calling" />)}
    </Box>
  );
}
