import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  DEFAULT_RPC_BASE,
  LiteRpc,
  type DynamicContractRegistryEntry,
} from "@qinit/core";
import { readState, type DecodedState } from "../../trace/format";
import { StateView } from "../../trace/views";
import { loadConfig, loadConfiguredQpiHeader } from "../../config";
import { loadContracts, mergeContracts } from "../../contracts/registry";
import { Header, Spinner, GradLine, Panel, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";
import { readStateDigest, type StateDigestResult } from "../../contracts/state-digest";

type DigestOutput = StateDigestResult | { ok: false; error: string };

export function State({ commandArgs }: { commandArgs: CommandArguments }) {
  const o = {
    target: commandArgs.positionals[0] ?? "",
    rpc: commandArgs.get("rpc"),
    digest: commandArgs.has("digest"),
  };
  const rpcBaseUrl = o.rpc || loadConfig().rpc || DEFAULT_RPC_BASE;
  const { exit } = useApp();
  const [lines, setLines] = useState<string[]>([]);
  const [decodedState, setDecodedState] = useState<DecodedState | null>(null);
  const [name, setName] = useState("");
  const [contracts, setContracts] = useState<DynamicContractRegistryEntry[]>([]);
  const [userCount, setUserCount] = useState(0); // contracts[0..userCount) deployed, rest system
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"loading" | "pick" | "show" | "done">("loading");
  const [digest, setDigest] = useState<DigestOutput | null>(null);
  const [progress, setProgress] = useState("");
  const add = (s: string) => setLines((l) => [...l, s]);

  const load = async (c: DynamicContractRegistryEntry) => {
    setPhase("loading");
    setProgress("");
    try {
      if (!c.source)
        throw new Error(`node has no source for slot ${c.index} — cannot decode state`);
      setName(c.name || String(c.index));
      const rpc = new LiteRpc(rpcBaseUrl);
      await rpc.tickInfo(); // fail fast + loud if the node is unreachable (else readState silently fills "(read failed)")
      setDecodedState(
        await readState(
          rpc,
          c.index,
          c.source,
          c.name || "Contract",
          loadConfiguredQpiHeader(),
          (field, completedBytes, totalBytes) => {
            const percent = totalBytes
              ? Math.floor((completedBytes * 100) / totalBytes)
              : 100;
            setProgress(`reading ${field} · ${percent}%`);
          },
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
        const rpc = new LiteRpc(rpcBaseUrl);
        if (o.digest) {
          setDigest(await readStateDigest(o.target, rpc));
          return;
        }
        const { all, userCount: deployed } = mergeContracts(await loadContracts(rpc));
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
        setUserCount(deployed);
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
      if (
        lines.some((l) => l.startsWith("ERROR")) ||
        decodedState?.complete === false
      ) {
        process.exitCode = 1;
      }
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
  }, [phase, digest, decodedState]);

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
              const row = (c: DynamicContractRegistryEntry, idx: number) => {
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
      {phase === "loading" && <Spinner label={progress || "reading state"} />}
      {decodedState ? <StateView name={name} state={decodedState} /> : null}
    </Box>
  );
}
