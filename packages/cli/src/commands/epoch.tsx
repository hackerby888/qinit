import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { LiteRpc } from "@qinit/core";
import { loadConfig } from "../config";
import { advanceTo } from "./tick";
import { Header, Spinner, Bar, KV, theme } from "../ui";

// qinit epoch           -> show the current-epoch tick window
// qinit epoch advance   -> advance to the next epoch. Fast-tick to the boundary (progress bar), then drive the
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = { sub: "" };
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rpc") o.rpc = args[++i] ?? "";
    else if (!a.startsWith("--")) pos.push(a);
  }
  o.sub = pos[0] ?? "";
  return o;
}

export function Epoch({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [prog, setProg] = useState<{ from: number; cur: number; target: number } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      const rpc = new LiteRpc(rpcBase);
      try {
        const e = await rpc.epochInfo();
        if (o.sub === "advance") {
          // 1) fast-tick to the last tick (progress); 2) let the node run its seamless transition.
          const target = e.epochLastTick;
          setProg({ from: e.tick, cur: e.tick, target });
          await advanceTo(rpc, target, e.tick, (c) => setProg((p) => p && { ...p, cur: c }));
          setProg(null);
          setBusy("transitioning to the next epoch");
          let r = await rpc.advanceEpoch();
          for (let i = 0; i < 3 && !r.switched; i++) r = await rpc.advanceEpoch(); // a few nudges if the boundary needs more ticks
          if (!r.switched)
            throw new Error(
              `epoch did not switch (still ${r.toEpoch}, tick ${r.tick}) — node may have timed out`,
            );
          setRows([
            ["epoch", `${r.fromEpoch} → ${r.toEpoch}`],
            ["tick", `${e.tick} → ${r.tick}`],
            ["new epoch start tick", String(r.initialTick)],
          ]);
        } else if (o.sub) {
          throw new Error(`unknown subcommand '${o.sub}' (use: advance)`);
        } else {
          setRows([
            ["epoch", String(e.epoch)],
            ["tick", String(e.tick)],
            ["epoch last tick", String(e.epochLastTick)],
            ["ticks left", String(e.ticksLeft)],
            ["epoch length", `${e.duration} ticks`],
          ]);
        }
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      }
      setProg(null);
      setBusy("");
    })();
  }, []);
  useEffect(() => {
    if (rows || err) {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
  }, [rows, err]);

  const pct =
    prog && prog.target > prog.from ? (prog.cur - prog.from) / (prog.target - prog.from) : 1;
  return (
    <Box flexDirection="column">
      <Header cmd="epoch" />
      {prog && (
        <Box flexDirection="column">
          <Text dimColor>fast-ticking to the epoch boundary</Text>
          <Text>
            <Bar pct={pct} />{" "}
            <Text dimColor>
              tick {prog.cur} / {prog.target}
            </Text>
          </Text>
        </Box>
      )}
      {busy && !prog && <Spinner label={busy} />}
      {err && <Text color={theme.err}>ERROR: {err}</Text>}
      {rows && (
        <Box marginTop={1}>
          <KV rows={rows} />
        </Box>
      )}
    </Box>
  );
}
