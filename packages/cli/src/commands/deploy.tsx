import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { Box, Text, useApp } from "ink";
import { contractAddress } from "@qinit/proto";
import { bytesToIdentity } from "@qinit/core";
import { loadConfig, resolveCore } from "../config";
import { deployContract, STEPS, type Ev, type DeployResult } from "../deploy-ops";
import { Header, StepRow, type StepState, Panel, KV, theme } from "../ui";

interface SS { state: StepState; detail?: string; pct?: number; startedAt?: number; elapsedMs?: number }

function parse(args: string[]): { o: Record<string, string>; pos: string[] } {
  const o: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) o[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "";
    else pos.push(args[i]);
  }
  return { o, pos };
}

export function Deploy({ args }: { args: string[] }) {
  const { o, pos } = parse(args);
  const { exit } = useApp();
  const [steps, setSteps] = useState<Record<string, SS>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [addr, setAddr] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const cpath = o.contract ?? pos[0] ?? cfg.contract;
        if (!cpath) throw new Error("no contract: pass `qinit deploy <file.h>` (or --contract <file.h>, or set contract in qinit.json)");
        const contractPath = resolve(cpath);
        const nm = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
        setName(nm);
        const dynCallees: Record<string, { header: string; index: number }> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== "--callee") continue;
          const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
          if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
        }
        const sv = o.slot ?? cfg.slot;
        const emit = (e: Ev) => {
          if ("note" in e) { setNotes((n) => [...n, e.note]); return; }
          setSteps((s) => {
            const prev = s[e.step] ?? {} as SS;
            const startedAt = e.state === "active" && !prev.startedAt ? Date.now() : prev.startedAt;
            const elapsedMs = (e.state === "ok" || e.state === "fail") && startedAt ? Date.now() - startedAt : prev.elapsedMs;
            return { ...s, [e.step]: { state: e.state, detail: e.detail ?? prev.detail, pct: e.pct ?? prev.pct, startedAt, elapsedMs } };
          });
        };
        const r = await deployContract({
          contractPath, name: nm, core: resolveCore(o.core, cfg.core),
          rpcBase: o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841", seed: o.seed, dynCallees,
          slotOverride: sv !== undefined && sv !== "" ? Number(sv) : undefined,
        }, emit);
        if (r.ok && r.slot != null) { try { setAddr(await bytesToIdentity(contractAddress(r.slot))); } catch {} }
        setResult(r);
      } catch (e: any) {
        setNotes((n) => [...n, "ERROR: " + String(e?.message ?? e).slice(0, 300)]);
        setResult({ ok: false, error: String(e?.message ?? e) });
      }
    })();
  }, []);
  useEffect(() => { if (result) { process.exitCode = result.ok ? 0 : 1; const t = setTimeout(() => exit(), 60); return () => clearTimeout(t); } }, [result]);

  return (
    <Box flexDirection="column">
      <Header cmd="deploy" />
      <Box flexDirection="column">
        {STEPS.map(({ key, label }) => {
          const s = steps[key] ?? { state: "pending" as StepState };
          return <StepRow key={key} state={s.state} label={label} detail={s.detail} pct={s.pct} elapsedMs={s.elapsedMs} />;
        })}
      </Box>
      {notes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {notes.map((n, i) => <Text key={i} color={n.startsWith("✗") || n.startsWith("ERROR") ? theme.err : n.startsWith("⚠") ? theme.warn : undefined} dimColor={!/^[✗⚠E]/.test(n)}>{n}</Text>)}
        </Box>
      )}
      {result?.ok && (
        <Box marginTop={1}>
          <Panel title="deployed ✓" color={theme.ok}>
            <KV full rows={[
              ["contract", name],
              ["slot", String(result.slot)],
              ["address", addr || `id(${result.slot},0,0,0)`],
              ["tx", result.txId ?? "—"],
              ["codeHash", result.hash ?? "—"],
              ["fns/procs", result.idl ? `${Object.keys(result.idl.functions).length} / ${Object.keys(result.idl.procedures).length}` : "—"],
            ]} />
            <Box marginTop={1}><Text dimColor>next: </Text><Text bold color={theme.accent}>qinit call</Text></Box>
          </Panel>
        </Box>
      )}
      {result && !result.ok && <Box marginTop={1}><Panel title="deploy failed" color={theme.err}><Text>{result.reason ?? result.error ?? "see steps above"}</Text></Panel></Box>}
      {!result && <Box marginTop={1}><Text dimColor>…</Text></Box>}
    </Box>
  );
}
