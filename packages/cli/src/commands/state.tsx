import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import { readState, type StateDump } from "../trace-format";
import { StateView } from "../views";
import { loadConfig } from "../config";
import { Header, Spinner, GradLine, theme } from "../ui";

// qinit state [<name|slot>] [--rpc <url>]
// Decode + print a deployed contract's CURRENT state. No target -> interactive picker of deployed contracts.
function parse(args: string[]): { target: string; rpc?: string } {
  let target = ""; let rpc: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rpc") rpc = args[++i];
    else if (!a.startsWith("--") && !target) target = a;
  }
  return { target, rpc };
}

export function State({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [dump, setDump] = useState<StateDump | null>(null);
  const [name, setName] = useState("");
  const [contracts, setContracts] = useState<DynContract[]>([]);
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"loading" | "pick" | "show" | "done">("loading");
  const add = (s: string) => setLines((l) => [...l, s]);

  const load = async (c: DynContract) => {
    setPhase("loading");
    try {
      if (!c.source) throw new Error(`node has no source for slot ${c.index} — cannot decode state`);
      setName(c.name || String(c.index));
      const rpc = new LiteRpc(rpcBase);
      setDump(await readState(rpc, c.index, c.source, c.name || "Contract"));
      setPhase("show");
    } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); setPhase("done"); }
  };

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBase);
        const reg = await rpc.dynRegistry();
        const armed = (reg.contracts ?? []).filter((x) => x.armed);
        if (o.target) {
          const c = armed.find((x) => String(x.index) === o.target || (x.name || "").toLowerCase() === o.target.toLowerCase());
          if (!c) throw new Error(`no deployed contract '${o.target}'`);
          await load(c);
          return;
        }
        if (!armed.length) throw new Error("no deployed contracts on the node");
        if (!process.stdin.isTTY) throw new Error(`specify a contract: qinit state <name|slot> (deployed: ${armed.map((c) => c.name || c.index).join(", ")})`);
        setContracts(armed); setPhase("pick");
      } catch (e: any) { add("ERROR: " + String(e?.message ?? e)); setPhase("done"); }
    })();
  }, []);
  useEffect(() => { if (phase === "show" || phase === "done") { const t = setTimeout(() => exit(), 50); return () => clearTimeout(t); } }, [phase]);

  useInput((input, key) => {
    if (phase !== "pick") return;
    if (input === "q" || key.escape) exit();
    else if (key.upArrow) setI((p) => (p - 1 + contracts.length) % contracts.length);
    else if (key.downArrow) setI((p) => (p + 1) % contracts.length);
    else if (key.return) load(contracts[i]);
  }, { isActive: Boolean(process.stdin.isTTY) });

  return (
    <Box flexDirection="column">
      <Header cmd="state" />
      {lines.map((l, k) => <Text key={k} color={l.startsWith("ERROR") ? theme.err : undefined}>{l}</Text>)}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ show state · q quit</Text>
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {contracts.map((c, idx) => {
              const sel = idx === i;
              const detail = `slot ${c.index} · ${c.functions?.length ?? 0}fn/${c.procedures?.length ?? 0}proc${c.source ? "" : " · no source"}`;
              return sel
                ? <GradLine key={c.index} text={`▸ ${(c.name || "—").padEnd(16)} ${detail}`} />
                : <Text key={c.index}>{"  "}<Text color={theme.brand}>{(c.name || "—").padEnd(16)}</Text> <Text dimColor>{detail}</Text></Text>;
            })}
          </Box>
        </Box>
      )}
      {phase === "loading" && <Spinner label="reading state" />}
      {dump ? <StateView name={name} dump={dump} /> : null}
    </Box>
  );
}
