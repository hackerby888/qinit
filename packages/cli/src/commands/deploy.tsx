import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { Box, Text, useApp } from "ink";
import { contractAddress } from "@qinit/proto";
import { DEFAULT_RPC_BASE, bytesToIdentity } from "@qinit/core";
import {
  loadConfig,
  resolveCoreDir,
  resolveCompilerBackend,
} from "../config";
import { deployContract, STEPS, type DeploymentEvent, type DeployResult } from "../deploy-ops";
import { Header, StepRow, type StepState, Panel, KV, theme } from "../ui";
import { output, parseCommandArgs } from "../args";
import { parseCallees } from "../callees";

interface SS {
  state: StepState;
  detail?: string;
  pct?: number;
  startedAt?: number;
  elapsedMs?: number;
}

export function Deploy({ args }: { args: string[] }) {
  const { flags: o, pos, multi } = parseCommandArgs("deploy", args);
  const dynCallees = parseCallees(multi.callee);
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
        if (!cpath)
          throw new Error(
            "no contract: pass `qinit deploy <file.h>` (or --contract <file.h>, or set contract in qinit.json)",
          );
        const contractPath = resolve(cpath);
        const nm =
          o["contract-name"] ??
          cfg.contractName ??
          basename(contractPath).replace(/\.[^.]+$/, "");
        setName(nm);
        const sv = o.slot ?? cfg.slot;
        const emit = (e: DeploymentEvent) => {
          if ("note" in e) {
            setNotes((n) => [...n, e.note]);
            return;
          }
          setSteps((s) => {
            const prev = s[e.step] ?? ({} as SS);
            const startedAt = e.state === "active" && !prev.startedAt ? Date.now() : prev.startedAt;
            const elapsedMs =
              (e.state === "ok" || e.state === "fail") && startedAt
                ? Date.now() - startedAt
                : prev.elapsedMs;
            return {
              ...s,
              [e.step]: {
                state: e.state,
                detail: e.detail ?? prev.detail,
                pct: e.pct ?? prev.pct,
                startedAt,
                elapsedMs,
              },
            };
          });
        };
        const r = await deployContract(
          {
            contractPath,
            name: nm,
            core: resolveCoreDir(o["core-dir"], cfg.coreDir),
            rpcBaseUrl: o.rpc ?? cfg.rpc ?? DEFAULT_RPC_BASE,
            seed: o.seed,
            dynCallees,
            slotOverride: sv !== undefined && sv !== "" ? Number(sv) : undefined,
            skipVerify: "skip-verify" in o, // parity with `qinit test --skip-verify` (deployContract already supports it)
            compiler: resolveCompilerBackend(o),
          },
          emit,
        );
        if (r.ok && r.slot != null) {
          try {
            setAddr(await bytesToIdentity(contractAddress(r.slot)));
          } catch {}
        }
        setResult(r);
      } catch (e: any) {
        setNotes((n) => [...n, "ERROR: " + String(e?.message ?? e).slice(0, 300)]);
        setResult({ ok: false, error: String(e?.message ?? e) });
      }
    })();
  }, []);
  useEffect(() => {
    if (result) {
      if (output.json)
        process.stdout.write(
          JSON.stringify({
            ok: result.ok,
            contract: name,
            slot: result.slot ?? null,
            address: addr || null,
            tx: result.txId ?? null,
            codeHash: result.hash ?? null,
            error: result.ok ? null : (result.reason ?? result.error ?? null),
          }) + "\n",
        );
      process.exitCode = result.ok ? 0 : 1;
      const t = setTimeout(() => exit(), 60);
      return () => clearTimeout(t);
    }
  }, [result]);

  if (output.json) return null;
  return (
    <Box flexDirection="column">
      <Header cmd="deploy" />
      <Box flexDirection="column">
        {STEPS.map(({ key, label }) => {
          const s = steps[key] ?? { state: "pending" as StepState };
          return (
            <StepRow
              key={key}
              state={s.state}
              label={label}
              detail={s.detail}
              pct={s.pct}
              elapsedMs={s.elapsedMs}
            />
          );
        })}
      </Box>
      {notes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {notes.map((n, i) => (
            <Text
              key={i}
              color={
                n.startsWith("✗") || n.startsWith("ERROR")
                  ? theme.err
                  : n.startsWith("⚠")
                    ? theme.warn
                    : undefined
              }
              dimColor={!/^[✗⚠E]/.test(n)}
            >
              {n}
            </Text>
          ))}
        </Box>
      )}
      {result?.ok && (
        <Box marginTop={1}>
          <Panel title="deployed ✓" color={theme.ok}>
            <KV
              full
              rows={[
                ["contract", name],
                ["slot", String(result.slot)],
                ["address", addr || `id(${result.slot},0,0,0)`],
                ["tx", result.txId ?? "—"],
                ["codeHash", result.hash ?? "—"],
                [
                  "fns/procs",
                  result.idl
                    ? `${result.idl.functions.length} / ${result.idl.procedures.length}`
                    : "—",
                ],
              ]}
            />
            <Box marginTop={1}>
              <Text dimColor>next: </Text>
              <Text bold color={theme.accent}>
                qinit call
              </Text>
            </Box>
          </Panel>
        </Box>
      )}
      {result && !result.ok && (
        <Box marginTop={1}>
          <Panel title="deploy failed" color={theme.err}>
            <Text>{result.reason ?? result.error ?? "see steps above"}</Text>
          </Panel>
        </Box>
      )}
      {!result && (
        <Box marginTop={1}>
          <Text dimColor>…</Text>
        </Box>
      )}
    </Box>
  );
}
