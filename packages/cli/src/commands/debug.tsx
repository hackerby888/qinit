import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LiteRpc, resolveTrapBacktrace, formatTrapBacktrace, type DebugEntry, type DynContract } from "@qinit/core";
import { describeTrace, type TraceView as TraceData } from "../trace-format";
import { TraceView } from "../views";
import { scratchDir } from "../node-ops";
import { loadConfig } from "../config";
import { Header, Table, Spinner, theme, type Column } from "../ui";

// qinit debug [--rpc <url>] [--contract <name|slot>]
// Live wasm contract-call inspector: enables the node debug toggle, polls the trace ring, shows each
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}
const kindName = (k: number) => (k === 0 ? "fn" : k === 1 ? "proc" : "sys");
const LIST_COLS: Column[] = [
  { header: "tick", align: "right", max: 10 },
  { header: "contract", max: 14 },
  { header: "entry", max: 9 },
  { header: "", max: 1 },
  { header: "exec", align: "right", max: 8, dim: true },
];

export function Debug({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const rpc = useRef(new LiteRpc(rpcBase)).current;
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState(0);
  const follow = useRef(true);
  const since = useRef(0);
  const reg = useRef<DynContract[]>([]);
  const nameOf = (idx: number) => reg.current.find((c) => c.index === idx)?.name || String(idx);

  useEffect(() => {
    let alive = true;
    rpc.setDebug(true).then((r) => alive && setEnabled(r.enabled)).catch((e) => setErr(String(e?.message ?? e)));
    const poll = setInterval(async () => {
      try {
        reg.current = (await rpc.dynRegistry()).contracts ?? [];
        const t = await rpc.debugTrace(since.current, 200);
        if (!alive || !t.entries.length) return;
        since.current = t.entries[t.entries.length - 1].seq;
        setEntries((prev) => [...prev, ...t.entries].slice(-500));
      } catch (e: any) { setErr(String(e?.message ?? e)); }
    }, 1200);
    return () => { alive = false; clearInterval(poll); rpc.setDebug(false).catch(() => {}); };
  }, []);

  // follow the tail until the user scrolls up
  useEffect(() => { if (follow.current) setSel(Math.max(0, entries.length - 1)); }, [entries.length]);

  // isActive=false in a non-TTY (CI/pipe) → Ink skips raw mode instead of throwing; still renders + polls.
  useInput((input, key) => {
    if (input === "q" || key.escape) { rpc.setDebug(false).catch(() => {}); exit(); }
    else if (key.upArrow) { follow.current = false; setSel((s) => Math.max(0, s - 1)); }
    else if (key.downArrow) setSel((s) => { const n = Math.min(entries.length - 1, s + 1); follow.current = n === entries.length - 1; return n; });
  }, { isActive: Boolean(process.stdin.isTTY) });

  const list = o.contract
    ? entries.filter((e) => nameOf(e.index).toLowerCase() === o.contract.toLowerCase() || String(e.index) === o.contract)
    : entries;
  const selClamped = Math.min(sel, Math.max(0, list.length - 1));
  const cur = list[selClamped];
  const start = Math.max(0, selClamped - 9);
  const win = list.slice(start, start + 18);

  return (
    <Box flexDirection="column">
      <Header cmd="debug" />
      <Text dimColor>{enabled ? "● capturing" : "toggle off"} · {list.length} calls · ↑/↓ select · q quit{err ? "   err: " + err : ""}</Text>
      {list.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          {enabled
            ? <Text color={theme.brand}><Spinner label="waiting for a contract invocation" /></Text>
            : <Text color={theme.warn}>capture is off — no traces will appear</Text>}
          <Text dimColor>  invoke a contract from another terminal: <Text color={theme.info}>qinit call</Text> (or <Text color={theme.info}>qinit deploy</Text>)</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Box flexDirection="column" width={46} marginRight={2}>
            <Table
              columns={LIST_COLS}
              rows={win.map((e) => [String(e.tick), nameOf(e.index), kindName(e.kind) + "#" + e.entry, e.ok ? "✓" : "✗", ((e.execNs / 1000) | 0) + "µs"])}
              selected={selClamped - start}
              rowColor={(i) => (!win[i].ok ? theme.err : undefined)}
            />
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {cur ? <Detail e={cur} name={nameOf(cur.index)} source={reg.current.find((c) => c.index === cur.index)?.source} rpc={rpc} /> : <Text dimColor>—</Text>}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function Detail({ e, name, source, rpc }: { e: DebugEntry; name: string; source?: string; rpc: LiteRpc }) {
  const [v, setV] = useState<TraceData | null>(null);
  const [bt, setBt] = useState<string>("");
  useEffect(() => {
    let alive = true;
    describeTrace(e, source, name, rpc).then((view) => { if (alive) setV(view); }).catch(() => {});
    setBt("");
    if (!e.ok) {   // trapped call: source-mapped backtrace from node.log + the slot's line map
      try {
        const all = existsSync("qinit.idl.json") ? JSON.parse(readFileSync("qinit.idl.json", "utf8")) : {};
        const log = join(scratchDir(), "node.log");
        if (existsSync(log)) { const b = resolveTrapBacktrace(readFileSync(log, "utf8"), { lineMapPath: all[String(e.index)]?.linesJson }); if (b?.frames.length && alive) setBt(formatTrapBacktrace(b)); }
      } catch {}
    }
    return () => { alive = false; };
  }, [e.seq]);
  return (
    <Box flexDirection="column">
      {v ? <TraceView e={e} name={name} view={v} /> : <Text dimColor>decoding…</Text>}
      {bt ? <Box marginTop={1} flexDirection="column">{bt.split("\n").map((l, i) => <Text key={i} color={theme.err}>{l}</Text>)}</Box> : null}
    </Box>
  );
}
