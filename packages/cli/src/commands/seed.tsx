import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { DEFAULT_RPC_BASE, LiteRpc, deriveIdentity } from "@qinit/core";
import { savedSeed, setSavedSeed, clearSavedSeed, seedStorePath, loadConfig } from "../config";
import { Header, Spinner, GradLine, theme } from "../ui";
import type { CommandArguments } from "../args";

type Item = { seed: string; id: string; balance: string };

const compactBalance = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatSeedBalance(balance: string): string {
  return `${compactBalance.format(BigInt(balance))} QUs`;
}

export function Seed({ commandArgs }: { commandArgs: CommandArguments }) {
  const rpcBaseUrl = commandArgs.get("rpc") || loadConfig().rpc || DEFAULT_RPC_BASE;
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [i, setI] = useState(0);
  // Selected index in a ref too: ink only re-subscribes useInput after React commits, so a fast arrow→↵ can hit
  // the pre-move handler and save the previously-highlighted seed. The ref updates synchronously per key event.
  const sel = useRef(0);
  const move = (d: number): void => {
    if (!items.length) {
      return;
    }
    sel.current = (sel.current + d + items.length) % items.length;
    setI(sel.current);
  };
  const [msg, setMsg] = useState<string[]>([]);
  const [phase, setPhase] = useState<"load" | "pick" | "done" | "err">("load");
  const add = (s: string) => setMsg((m) => [...m, s]);

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBaseUrl);
        if (commandArgs.has("clear")) {
          clearSavedSeed();
          add("cleared saved seed (" + seedStorePath() + ")");
          setPhase("done");
          return;
        }
        if (commandArgs.has("show")) {
          const s = savedSeed();
          if (!s) {
            add("no saved seed — run `qinit seed` to pick one");
            setPhase("done");
            return;
          }

          const id = (await deriveIdentity(s)).identity;
          const balance = await rpc.balance(id);
          add(
            `saved seed: ${s}\n  identity: ${id}\n  balance: ${formatSeedBalance(balance.balance)}`,
          );
          setPhase("done");
          return;
        }
        const r = await rpc.fundedSeeds(32);
        if (!r.seeds?.length)
          throw new Error(
            "node returned no funded seeds (needs a testnet node with broadcastedComputorSeeds)",
          );
        setItems(
          await Promise.all(
            r.seeds.map(async (seed) => {
              const id = (await deriveIdentity(seed)).identity;
              const balance = await rpc.balance(id);

              return {
                seed,
                id,
                balance: formatSeedBalance(balance.balance),
              };
            }),
          ),
        );
        setPhase("pick");
      } catch (e: any) {
        add("ERROR: " + String(e?.message ?? e));
        setPhase("err");
      }
    })();
  }, []);
  useEffect(() => {
    if (phase === "done" || phase === "err") {
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
  }, [phase]);

  useInput(
    (input, key) => {
      if (phase !== "pick") return;
      if (input === "q" || key.escape) exit();
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (key.return) {
        const s = items[sel.current];
        try {
          setSavedSeed(s.seed);
          add("✓ saved → " + seedStorePath());
          add("identity: " + s.id);
        } catch (e: any) {
          add("ERROR: " + String(e?.message ?? e));
        }
        setPhase("done");
      }
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const cur = savedSeed();
  const WIN = 8; // each item renders 2 lines (full id + full seed) — keep the visible window short
  const start = Math.max(0, Math.min(i - 4, items.length - WIN));
  const balanceWidth = Math.max(0, ...items.map((item) => item.balance.length));
  return (
    <Box flexDirection="column">
      <Header cmd="seed" />
      {phase === "load" && <Spinner label="fetching funded seeds" />}
      {phase === "err" &&
        msg.map((m, k) => (
          <Text key={k} color={theme.err}>
            {m}
          </Text>
        ))}
      {phase === "done" &&
        msg.map((m, k) => (
          <Text key={k} color={m.startsWith("ERROR") ? theme.err : theme.ok}>
            {m}
          </Text>
        ))}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ save · q quit</Text>
          {cur ? (
            <Text dimColor>
              current: <Text color={theme.ok}>{cur}</Text>
            </Text>
          ) : null}
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {items.slice(Math.max(0, start), Math.max(0, start) + WIN).map((it, k) => {
              const idx = start + k,
                sel = idx === i;
              const balance = it.balance.padStart(balanceWidth);
              return (
                <Box key={idx} flexDirection="column">
                  {sel ? (
                    <GradLine text={`▸ ${it.id}  ${balance}`} />
                  ) : (
                    <Text>
                      {"  "}
                      <Text color={theme.info}>{it.id}</Text>
                      <Text color={theme.ok}>{`  ${balance}`}</Text>
                    </Text>
                  )}
                  <Text dimColor>
                    {"  "}
                    {it.seed}
                    {it.seed === cur ? <Text color={theme.ok}>  ✓ current</Text> : null}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </Box>
  );
}
