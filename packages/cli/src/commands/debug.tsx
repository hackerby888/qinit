import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, bytesToIdentity, type DebugEntry, type DynContract } from "@qinit/core";
import { decodeOutput, layoutOf, decodeHashMap, decodeHashSet, decodeCollection, decodeLog, type DecodedLog } from "@qinit/proto";
import { extractIdl } from "@qinit/build";
import { loadConfig } from "../config";
import { Header, Panel, KV, theme } from "../ui";

// qinit debug [--rpc <url>] [--contract <name|slot>]
// Live wasm contract-call inspector: enables the node debug toggle, polls the trace ring, shows each
// call's decoded input/output, state diff, QPI host-calls, trap + timing. ↑/↓ select, q quit.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length));
const roundUp = (o: number, a: number) => (a <= 1 ? o : Math.ceil(o / a) * a);
const kindName = (k: number) => (k === 0 ? "fn" : k === 1 ? "proc" : "sys");
const hexToBytes = (h: string) => { const a = new Uint8Array((h.length / 2) | 0); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const jstr = (v: any) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

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
  const view = list.slice(Math.max(0, selClamped - 9), Math.max(0, selClamped - 9) + 18);

  return (
    <Box flexDirection="column">
      <Header cmd="debug" />
      <Text dimColor>{enabled ? "● capturing" : "toggle off"} · {list.length} calls · ↑/↓ select · q quit{err ? "   err: " + err : ""}</Text>
      <Box marginTop={1}>
        <Box flexDirection="column" width={46} marginRight={2}>
          {list.length === 0 ? <Text dimColor>no calls yet — invoke a contract</Text> : view.map((e) => {
            const isSel = e.seq === cur?.seq;
            return (
              <Text key={e.seq} inverse={isSel} color={!e.ok ? theme.err : undefined}>
                {pad(String(e.tick), 9)}{pad(nameOf(e.index), 12)}{pad(kindName(e.kind) + "#" + e.entry, 8)}{e.ok ? "✓" : "✗"} {((e.execNs / 1000) | 0) + "µs"}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {cur ? <Detail e={cur} name={nameOf(cur.index)} source={reg.current.find((c) => c.index === cur.index)?.source} rpc={rpc} /> : <Text dimColor>—</Text>}
        </Box>
      </Box>
    </Box>
  );
}

type Container = { kind: "hashmap" | "hashset" | "collection"; keyFmt: string; valFmt?: string; capacity: number };
type StateField = { name: string; off: number; size: number; container?: Container };
type ColView = { name: string; entries: string[] };
const shortKey = (k: unknown) => (typeof k === "string" && k.length === 60 ? k.slice(0, 10) + "…" : jstr(k));

function Detail({ e, name, source, rpc }: { e: DebugEntry; name: string; source?: string; rpc: LiteRpc }) {
  const [io, setIo] = useState<{ in: string; out: string }>({ in: "…", out: "…" });
  const [caller, setCaller] = useState("…");
  const [fields, setFields] = useState<StateField[]>([]);
  const [cols, setCols] = useState<ColView[]>([]);
  const [logs, setLogs] = useState<DecodedLog[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      let inS = e.inHex ? "0x" + e.inHex : "(none)";
      let outS = e.outHex ? "0x" + e.outHex : "(none)";
      // caller: procedures carry the tx-signer id -> render the 60-char Qubic identity; none for fn/sysproc.
      let cal = "(none)";
      if (e.kind === 1 && !/^0+$/.test(e.invocator)) { try { cal = await bytesToIdentity(hexToBytes(e.invocator)); } catch { cal = "0x" + e.invocator.slice(0, 16) + "…"; } }
      let flds: StateField[] = [];
      const colv: ColView[] = [];
      let catalog: { name: string; fmt: string; fields: string[] }[] = [];
      try {
        if (source) {
          const idl = extractIdl(source, name);
          catalog = idl.logStructs ?? [];
          const ent: any = (e.kind === 0 ? idl.functions : idl.procedures)?.[String(e.entry)];
          if (ent?.in && e.inHex) inS = jstr(await decodeOutput(hexToBytes(e.inHex), ent.in));
          if (ent?.out && e.outHex) outS = jstr(await decodeOutput(hexToBytes(e.outHex), ent.out));
          if (idl.state?.length) {                                  // StateData field map for diff naming + container decode
            // per-field walk (NOT join+structFieldOffsets — a single struct-typed field collapses + unwraps wrong)
            let acc = 0;
            flds = idl.state.map((f) => { const L = layoutOf(f.type); acc = roundUp(acc, L.align); const r = { name: f.name, off: acc, size: L.size, container: f.container }; acc += L.size; return r; });
            for (const f of flds) {                                 // logical-entry decode of current container contents
              if (!f.container) continue;
              try {
                const sr = await rpc.stateRead(e.index, f.off, Math.min(f.size, 262144));
                const buf = hexToBytes(sr.hex); const c = f.container;
                const ents = c.kind === "hashmap"
                  ? (await decodeHashMap(buf, c.keyFmt, c.valFmt!, c.capacity)).map((x) => `${shortKey(x.key)} = ${jstr(x.value)}`)
                  : c.kind === "collection"
                    ? (await decodeCollection(buf, c.valFmt!, c.capacity)).map((x) => `${shortKey(x.pov)}: ${jstr(x.value)} (p${x.priority})`)
                    : (await decodeHashSet(buf, c.keyFmt, c.capacity)).map((x) => shortKey(x.key));
                colv.push({ name: f.name, entries: ents.length > 10 ? ents.slice(0, 10).concat("… +" + (ents.length - 10)) : ents });
              } catch {}
            }
          }
        }
      } catch {}
      // contract LOG_* calls: size-match the bytes against the log-struct catalog + decode (hex fallback).
      let lgs: DecodedLog[] = [];
      try { if (e.logs?.length) lgs = await Promise.all(e.logs.map((l) => decodeLog(l.type, l.size, l.hex, catalog))); } catch {}
      if (alive) { setIo({ in: inS, out: outS }); setCaller(cal); setFields(flds); setCols(colv); setLogs(lgs); }
    })();
    return () => { alive = false; };
  }, [e.seq]);

  const sevColor = (s: string) => (s === "ERROR" ? theme.err : s === "WARN" ? theme.accent : s === "INFO" ? theme.ok : undefined);

  // map a changed byte offset to its StateData field (name[+rel]); raw @off if no layout / unmatched.
  const labelOff = (off: number): string => {
    const f = fields.find((x) => off >= x.off && off < x.off + x.size);
    return f ? f.name + (off > f.off ? "+" + (off - f.off) : "") : "@" + off;
  };

  return (
    <Box flexDirection="column">
      <Panel title={`${name} · ${kindName(e.kind)}#${e.entry}`} color={e.ok ? theme.ok : theme.err}>
        <KV rows={[
          ["tick", String(e.tick)], ["ok", e.ok ? "yes" : "no"], ["exec", ((e.execNs / 1000) | 0) + " µs"],
          ["reward", String(e.invocationReward)], ["caller", caller],
        ]} />
      </Panel>
      {e.trap ? <Panel title="trap" color={theme.err}><Text color={theme.err} wrap="wrap">{e.trap}</Text></Panel> : null}
      <Panel title="input / output">
        <Text wrap="truncate-end">in:  {io.in}</Text>
        <Text wrap="truncate-end">out: {io.out}</Text>
      </Panel>
      <Panel title={`state diff${e.stateTruncated ? " (truncated)" : ""}${e.stateDiff.length ? " · " + e.stateDiff.length + " region(s)" : ""}`}>
        {e.stateDiff.length ? e.stateDiff.slice(0, 12).map((d, i) => <Text key={i}><Text bold>{labelOff(d.off)}</Text>: <Text color={theme.err}>{d.before}</Text> → <Text color={theme.ok}>{d.after}</Text></Text>)
          : <Text dimColor>no state change</Text>}
      </Panel>
      {cols.map((c) => (
        <Panel key={c.name} title={`${c.name} · ${c.entries.length ? c.entries.length + " entries" : "empty"} (current)`}>
          {c.entries.length ? <Box flexDirection="column">{c.entries.map((x, i) => <Text key={i} wrap="truncate-end">{x}</Text>)}</Box> : <Text dimColor>empty</Text>}
        </Panel>
      ))}
      {logs.length ? (
        <Panel title={`logs (${logs.length})`}>
          <Box flexDirection="column">{logs.map((l, i) => (
            <Text key={i} wrap="truncate-end">
              <Text bold color={sevColor(l.severity)}>{l.severity}</Text>{" "}
              {l.name ? <><Text color={theme.accent}>{l.name}</Text> <Text dimColor>{jstr(l.fields)}</Text></> : <Text dimColor>{l.size}B {l.hex.slice(0, 34)}…</Text>}
            </Text>
          ))}</Box>
        </Panel>
      ) : null}
      {e.hostCalls.length ? (
        <Panel title={`host calls (${e.hostCalls.length})`}>
          <Box flexDirection="column">{e.hostCalls.map((h, i) => <Text key={i}><Text color={theme.accent}>{h.name}</Text> <Text dimColor>{h.detail}</Text></Text>)}</Box>
        </Panel>
      ) : null}
    </Box>
  );
}
