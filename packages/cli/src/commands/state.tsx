import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { LiteRpc, type DynContract } from "@qinit/core";
import { readState, type StateDump } from "../trace-format";
import { StateView } from "../views";
import { loadConfig, loadConfiguredQpiHeader } from "../config";
import { loadContracts, systemAsDyn } from "../contracts";
import { Header, Spinner, GradLine, Panel, KV, theme } from "../ui";
import { output } from "../args";
import { readStateDigest, type StateDigestResult } from "../state-digest";

// qinit state [<name|slot>] [--digest] [--json] [--rpc <url>]
// Decode + print a deployed contract's CURRENT state. No target -> interactive picker of deployed contracts.
function parse(args: string[]): { target: string; rpc?: string; all: boolean; digest: boolean } {
  let target = "";
  let rpc: string | undefined;
  let all = false;
  let digest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rpc") rpc = args[++i];
    else if (a === "--all") all = true;
    else if (a === "--digest") digest = true;
    else if (!a.startsWith("--") && !target) target = a;
  }
  return { target, rpc, all, digest };
}

type DigestOutput = StateDigestResult | { ok: false; error: string };

export function State({ args }: { args: string[] }) {
  const o = parse(args);
  const rpcBase = o.rpc || loadConfig().rpc || "http://127.0.0.1:41841";
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [dump, setDump] = useState<StateDump | null>(null);
  const [name, setName] = useState("");
  const [contracts, setContracts] = useState<DynContract[]>([]);
  const [userCount, setUserCount] = useState(0); // contracts[0..userCount) deployed, rest system
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"loading" | "pick" | "show" | "done">("loading");
  const [digest, setDigest] = useState<DigestOutput | null>(null);
  const add = (s: string) => setLines((l) => [...l, s]);

  const load = async (c: DynContract) => {
    setPhase("loading");
    try {
      if (!c.source)
        throw new Error(`node has no source for slot ${c.index} — cannot decode state`);
      setName(c.name || String(c.index));
      const rpc = new LiteRpc(rpcBase);
      await rpc.tickInfo(); // fail fast + loud if the node is unreachable (else readState silently fills "(read failed)")
      setDump(
        await readState(
          rpc,
          c.index,
          c.source,
          c.name || "Contract",
          o.all,
          loadConfiguredQpiHeader(),
        ),
      );
      setPhase("show");
    } catch (e: any) {
      add("ERROR: " + String(e?.message ?? e));
      setPhase("done");
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBase);
        if (o.digest) {
          setDigest(await readStateDigest(o.target, rpc));
          return;
        }
        const { user, system } = await loadContracts(rpc); // deployed first, then system (catalog)
        const all = [...user, ...system.map(systemAsDyn)];
        if (o.target) {
          const c = all.find(
            (x) =>
              String(x.index) === o.target ||
              (x.name || "").toLowerCase() === o.target.toLowerCase(),
          );
          if (!c)
            throw new Error(
              `no contract '${o.target}' (deployed or system — run \`qinit node run\` for system)`,
            );
          await load(c);
          return;
        }
        if (!all.length)
          throw new Error(
            "no contracts — deploy one, or run `qinit node run` to load system contracts",
          );
        if (!process.stdin.isTTY)
          throw new Error(
            `specify a contract: qinit state <name|slot> (${all.map((c) => c.name || c.index).join(", ")})`,
          );
        setContracts(all);
        setUserCount(user.length);
        setPhase("pick");
      } catch (e: any) {
        if (o.digest) {
          setDigest({ ok: false, error: String(e?.message ?? e) });
          return;
        }
        add("ERROR: " + String(e?.message ?? e));
        setPhase("done");
      }
    })();
  }, []);
  useEffect(() => {
    if (digest) {
      if (output.json) process.stdout.write(JSON.stringify(digest) + "\n");
      process.exitCode = digest.ok ? 0 : 1;
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
    if (!o.digest && (phase === "show" || phase === "done")) {
      if (lines.some((l) => l.startsWith("ERROR"))) process.exitCode = 1;
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
  }, [phase, digest]);

  useInput(
    (input, key) => {
      if (phase !== "pick") return;
      if (input === "q" || key.escape) exit();
      else if (key.upArrow) setI((p) => (p - 1 + contracts.length) % contracts.length);
      else if (key.downArrow) setI((p) => (p + 1) % contracts.length);
      else if (key.return) load(contracts[i]);
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  if (o.digest && output.json) return null;
  if (o.digest) {
    return (
      <Box flexDirection="column">
        <Header cmd="state" />
        {!digest ? (
          <Spinner label="reading state digest" />
        ) : digest.ok ? (
          <Panel title="state digest ✓" color={theme.ok}>
            <KV
              rows={[
                ["slot", String(digest.slot)],
                ["state size", String(digest.stateSize)],
                ["digest", digest.digest],
              ]}
            />
          </Panel>
        ) : (
          <Panel title="state digest failed" color={theme.err}>
            <Text>{digest.error}</Text>
          </Panel>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header cmd="state" />
      {lines.map((l, k) => (
        <Text key={k} color={l.startsWith("ERROR") ? theme.err : undefined}>
          {l}
        </Text>
      ))}
      {phase === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>↑/↓ select · ↵ show state · q quit</Text>
          <Box borderStyle="round" borderColor={theme.brand} paddingX={1} flexDirection="column">
            {(() => {
              const row = (c: DynContract, idx: number) => {
                const sel = idx === i;
                const detail = `idx ${c.index} · ${c.functions?.length ?? 0}fn/${c.procedures?.length ?? 0}proc`;
                return sel ? (
                  <GradLine key={c.index} text={`▸ ${(c.name || "—").padEnd(16)} ${detail}`} />
                ) : (
                  <Text key={c.index}>
                    {"  "}
                    <Text color={theme.brand}>{(c.name || "—").padEnd(16)}</Text>{" "}
                    <Text dimColor>{detail}</Text>
                  </Text>
                );
              };
              const out: React.ReactNode[] = [];
              if (userCount > 0) {
                out.push(
                  <Text key="hu" color={theme.mute} bold>
                    {" "}
                    deployed
                  </Text>,
                );
                contracts.slice(0, userCount).forEach((c, k) => out.push(row(c, k)));
              }
              if (contracts.length > userCount) {
                out.push(
                  <Text key="hs" color={theme.mute} bold>
                    {" "}
                    system
                  </Text>,
                );
                contracts.slice(userCount).forEach((c, k) => out.push(row(c, userCount + k)));
              }
              return out;
            })()}
          </Box>
        </Box>
      )}
      {phase === "loading" && <Spinner label="reading state" />}
      {dump ? <StateView name={name} dump={dump} full={o.all} /> : null}
    </Box>
  );
}
