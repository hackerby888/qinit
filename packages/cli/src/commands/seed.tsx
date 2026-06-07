import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, deriveIdentity } from "@qinit/core";
import { savedSeed, setSavedSeed, clearSavedSeed, seedStorePath, loadConfig } from "../config";
import { Header, Spinner, GradLine, theme } from "../ui";

// qinit seed [--clear] [--show] [--rpc <url>]
// Pick one of the node's funded seeds; saved globally (XDG config, 0600) and auto-used wherever a seed is needed.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === "--rpc") o.rpc = args[++i] ?? ""; else if (a.startsWith("--")) o[a.slice(2)] = ""; }
  return o;
}
type Item = { seed: string; id: string };

export function Seed({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [i, setI] = useState(0);
  const [msg, setMsg] = useState<string[]>([]);
  const [phase, setPhase] = useState<"load" | "pick" | "done" | "err">("load");
  const add = (s: string) => setMsg((m) => [...m, s]);

  useEffect(() => {
    (async () => {
      try {
        if (o.clear !== undefined) { clearSavedSeed(); add("cleared saved seed (" + seedStorePath() + ")"); setPhase("done"); return; }
        if (o.show !== undefined) {
          const s = savedSeed();
          add(s ? "saved seed: " + s + "\n  identity: " + (await deriveIdentity(s)).identity : "no saved seed — run `qinit seed` to pick one");
          setPhase("done"); return;
        }
        const r = await new LiteRpc(rpcBase).fundedSeeds(32);
        if (!r.seeds?.length) throw new Error("node returned no funded seeds (needs a testnet node with broadcastedComputorSeeds)");
        setItems(await Promise.all(r.seeds.map(async (seed) => ({ seed, id: (await deriveIdentity(seed)).identity }))));
        setPhase("pick");
      } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); setPhase("err"); }
    })();
  }, []);
  useEffect(() => { if (phase === "done" || phase === "err") { const t = setTimeout(() => exit(), 30); return () => clearTimeout(t); } }, [phase]);

  useInput((input, key) => {
    if (phase !== "pick") return;
    if (input === "q" || key.escape) exit();
    else if (key.upArrow) setI((p) => (p - 1 + items.length) % items.length);
    else if (key.downArrow) setI((p) => (p + 1) % items.length);
    else if (key.return) { const s = items[i]; try { setSavedSeed(s.seed); add("✓ saved → " + seedStorePath()); add("identity: " + s.id); } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); } setPhase("done"); }
  }, { isActive: Boolean(process.stdin.isTTY) });

  const cur = savedSeed();
  const WIN = 8;   // each item renders 2 lines (full id + full seed) — keep the visible window short
  const start = Math.max(0, Math.min(i - 4, items.length - WIN));
  return (
    <Box flexDirection="column">
      <Header cmd="seed" />
      {phase === "load" && <Spinner label="fetching funded seeds" />}
      {phase === "err" && msg.map((m, k) => <Text key={k} color={theme.err}>{m}</Text>)}
      {phase === "done" && msg.map((m, k) => <Text key={k} color={m.startsWith("ERROR") ? theme.err : theme.ok}>{m}</Text>)}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ save · q quit</Text>
          {cur ? <Text dimColor>current: <Text color={theme.ok}>{cur}</Text></Text> : null}
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {items.slice(Math.max(0, start), Math.max(0, start) + WIN).map((it, k) => {
              const idx = start + k, sel = idx === i;
              const cm = it.seed === cur ? "  ✓ current" : "";
              return <Box key={idx} flexDirection="column">
                {sel
                  ? <GradLine text={"▸ " + it.id + cm} />
                  : <Text>{"  "}<Text color={theme.info}>{it.id}</Text>{it.seed === cur ? <Text color={theme.ok}> ✓ current</Text> : null}</Text>}
                <Text dimColor>{"  "}{it.seed}</Text>
              </Box>;
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
