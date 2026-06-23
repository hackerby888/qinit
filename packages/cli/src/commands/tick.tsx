import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc } from "@qinit/core";
import { loadConfig } from "../config";
import { Header, Spinner, Bar, KV, theme } from "../ui";

// qinit tick                     -> show the current-epoch tick window
// qinit tick advance <n>         -> advance the chain by n ticks (capped at the epoch's last tick)
// qinit tick advance-to-last [g] -> advance to (lastTick - g), default g=3 (the pre-transition resting point)
// qinit tick rate <ms>           -> virtualnode: set ms-per-tick on the running node (no respawn; 0 = fastest)
// Big jumps run in bounded server batches with a progress bar (each tick is a real tick — a few per second).
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = { sub: "", arg: "" };
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === "--rpc") o.rpc = args[++i] ?? ""; else if (!a.startsWith("--")) pos.push(a); }
  o.sub = pos[0] ?? ""; o.arg = pos[1] ?? "";
  return o;
}

// Drive system.tick to `target` via repeated bounded advance-tick calls. Returns the tick reached.
export async function advanceTo(rpc: LiteRpc, target: number, from: number, onProgress: (cur: number) => void): Promise<{ cur: number; capped: boolean }> {
  let cur = from, stalls = 0, capped = false;
  while (cur < target) {
    const r = await rpc.advanceTick(target - cur);
    capped = r.cappedAtEpochEnd;
    if (r.reached <= cur) { if (++stalls >= 3) break; } else stalls = 0;
    cur = r.reached; onProgress(cur);
    if (capped && cur >= r.epochLastTick) break;
  }
  return { cur, capped };
}

export function Tick({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [prog, setProg] = useState<{ from: number; cur: number; target: number; label: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const rpc = new LiteRpc(rpcBase);
      try {
        if (o.sub === "rate") {
          // virtualnode only: change the engine's ms-per-tick on the fly (no respawn). 0 = fastest.
          const ms = Math.floor(Number(o.arg));
          if (!Number.isFinite(ms) || ms < 0) throw new Error(`rate <ms>: '${o.arg}' is not a non-negative integer`);
          const r = await rpc.setTickMs(ms);
          setRows([["tick rate", `${r.tickMs} ms/tick${r.tickMs === 0 ? "  (fastest)" : ""}`]]);
          setProg(null); setBusy("");
          return;
        }
        const e = await rpc.epochInfo();
        if (o.sub === "advance") {
          const n = Math.floor(Number(o.arg || "1"));
          if (!Number.isFinite(n) || n < 1) throw new Error(`advance <n>: '${o.arg}' is not a positive integer`);
          const target = Math.min(e.tick + n, e.epochLastTick);
          setProg({ from: e.tick, cur: e.tick, target, label: `advancing ${n} tick${n === 1 ? "" : "s"}` });
          const { cur, capped } = await advanceTo(rpc, target, e.tick, (c) => setProg((p) => p && { ...p, cur: c }));
          setRows([["tick", `${e.tick} → ${cur}`], ["advanced", String(cur - e.tick)],
            ...(capped ? [["note", `capped at epoch last tick ${e.epochLastTick} — use 'qinit epoch advance' to cross`] as [string, string]] : [])]);
        } else if (o.sub === "advance-to-last" || o.sub === "last") {
          const gap = Math.max(0, Math.floor(Number(o.arg || "3")));
          const target = Math.max(e.tick, e.epochLastTick - gap);
          setProg({ from: e.tick, cur: e.tick, target, label: `advancing to last tick − ${gap}` });
          const { cur } = await advanceTo(rpc, target, e.tick, (c) => setProg((p) => p && { ...p, cur: c }));
          setRows([["tick", `${e.tick} → ${cur}`], ["epoch last tick", String(e.epochLastTick)], ["epoch", String(e.epoch)]]);
        } else if (o.sub) {
          throw new Error(`unknown subcommand '${o.sub}' (use: advance <n> | advance-to-last [gap] | rate <ms>)`);
        } else {
          setRows([["epoch", String(e.epoch)], ["tick", String(e.tick)], ["epoch last tick", String(e.epochLastTick)],
            ["ticks left", String(e.ticksLeft)], ["epoch length", `${e.duration} ticks`]]);
        }
      } catch (e: any) { setErr(String(e?.message ?? e)); }
      setProg(null); setBusy("");
    })();
  }, []);
  useEffect(() => { if (rows || err) { const t = setTimeout(() => exit(), 30); return () => clearTimeout(t); } }, [rows, err]);

  const pct = prog && prog.target > prog.from ? (prog.cur - prog.from) / (prog.target - prog.from) : 1;
  return (
    <Box flexDirection="column">
      <Header cmd="tick" />
      {prog && <Box flexDirection="column"><Text dimColor>{prog.label}</Text><Text><Bar pct={pct} /> <Text dimColor>tick {prog.cur} / {prog.target}</Text></Text></Box>}
      {busy && !prog && <Spinner label={busy} />}
      {err && <Text color={theme.err}>ERROR: {err}</Text>}
      {rows && <Box marginTop={1}><KV rows={rows} /></Box>}
    </Box>
  );
}
