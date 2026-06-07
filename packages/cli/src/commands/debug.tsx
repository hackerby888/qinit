import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DebugEntry, type DynContract } from "@qinit/core";
import { decodeOutput } from "@qinit/proto";
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
const kindName = (k: number) => (k === 0 ? "fn" : k === 1 ? "proc" : "sys");
const hexToBytes = (h: string) => { const a = new Uint8Array((h.length / 2) | 0); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
const jstr = (v: any) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// byte-level state diff (v1: no StateData layout) — list changed offsets in the captured prefix.
function stateDiff(before: string, after: string): { off: number; b: string; a: string }[] {
  const out: { off: number; b: string; a: string }[] = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n && out.length < 24; i += 2) {
    const b = before.substr(i, 2), a = after.substr(i, 2);
    if (b !== a) out.push({ off: i / 2, b, a });
  }
  return out;
}

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
          {cur ? <Detail e={cur} name={nameOf(cur.index)} source={reg.current.find((c) => c.index === cur.index)?.source} /> : <Text dimColor>—</Text>}
        </Box>
      </Box>
    </Box>
  );
}

function Detail({ e, name, source }: { e: DebugEntry; name: string; source?: string }) {
  const [io, setIo] = useState<{ in: string; out: string }>({ in: "…", out: "…" });
  useEffect(() => {
    let alive = true;
    (async () => {
      let inS = e.inHex ? "0x" + e.inHex : "(none)";
      let outS = e.outHex ? "0x" + e.outHex : "(none)";
      try {
        if (source) {
          const idl = extractIdl(source, name);
          const ent: any = (e.kind === 0 ? idl.functions : idl.procedures)?.[String(e.entry)];
          if (ent?.in && e.inHex) inS = jstr(await decodeOutput(hexToBytes(e.inHex), ent.in));
          if (ent?.out && e.outHex) outS = jstr(await decodeOutput(hexToBytes(e.outHex), ent.out));
        }
      } catch {}
      if (alive) setIo({ in: inS, out: outS });
    })();
    return () => { alive = false; };
  }, [e.seq]);

  const diff = stateDiff(e.stateBeforeHex, e.stateAfterHex);
  return (
    <Box flexDirection="column">
      <Panel title={`${name} · ${kindName(e.kind)}#${e.entry}`} color={e.ok ? theme.ok : theme.err}>
        <KV rows={[
          ["tick", String(e.tick)], ["ok", e.ok ? "yes" : "no"], ["exec", ((e.execNs / 1000) | 0) + " µs"],
          ["reward", String(e.invocationReward)], ["caller", e.invocator.replace(/0+$/, "").slice(0, 16) || "0"],
        ]} />
      </Panel>
      {e.trap ? <Panel title="trap" color={theme.err}><Text color={theme.err} wrap="wrap">{e.trap}</Text></Panel> : null}
      <Panel title="input / output">
        <Text wrap="truncate-end">in:  {io.in}</Text>
        <Text wrap="truncate-end">out: {io.out}</Text>
      </Panel>
      <Panel title={"state diff" + (e.stateTruncated ? " (state > capture cap)" : "")}>
        {diff.length ? diff.map((d, i) => <Text key={i}>@{d.off}: <Text color={theme.err}>{d.b}</Text> → <Text color={theme.ok}>{d.a}</Text></Text>)
          : <Text dimColor>no change in first {(e.stateBeforeHex.length / 2) | 0}B</Text>}
      </Panel>
      {e.hostCalls.length ? (
        <Panel title={`host calls (${e.hostCalls.length})`}>
          <Box flexDirection="column">{e.hostCalls.map((h, i) => <Text key={i}><Text color={theme.accent}>{h.name}</Text> <Text dimColor>{h.detail}</Text></Text>)}</Box>
        </Panel>
      ) : null}
    </Box>
  );
}
