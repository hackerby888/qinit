import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { resolve, basename } from "node:path";
import { statSync } from "node:fs";
import { loadConfig, resolveCore, resolveCompiler } from "../config";
import { deployContract, STEPS, type Ev, type DeployResult } from "../deploy-ops";
import { nodeContracts } from "../node-ops";
import { LiteRpc } from "@qinit/core";
import { Header, StepRow, type StepState, Panel, theme } from "../ui";
import { parseArgs } from "../args";

interface SS {
  state: StepState;
  detail?: string;
  pct?: number;
  startedAt?: number;
  elapsedMs?: number;
}

export function Dev({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { flags: o, pos, multi } = parseArgs(args, {
    strings: ["contract", "name", "core", "rpc", "seed"],
    booleans: ["native", "local", "skip-verify"],
    multi: ["callee"],
  });
  const cfg = loadConfig();
  const rpcBase = o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841";
  const contractPath = resolve(o.contract ?? pos[0] ?? cfg.contract ?? "fixtures/Counter.h");
  const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
  const dynCallees: Record<string, { header: string; index: number }> = {};
  for (const value of multi.callee ?? []) {
    const m = value.match(/^(\w+)=(.+)@(\d+)$/);
    if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
  }
  let core = "",
    coreErr = "";
  try {
    core = resolveCore(o.core, cfg.core);
  } catch (e: any) {
    coreErr = String(e?.message ?? e);
  }

  const [steps, setSteps] = useState<Record<string, SS>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [contracts, setContracts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState(0);
  const [tick, setTick] = useState<number | null>(null);
  const busyRef = useRef(false);
  const pending = useRef(false);

  const emit = (e: Ev) => {
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

  const redeploy = async () => {
    if (busyRef.current) {
      pending.current = true;
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setSteps({});
    setNotes([]);
    setResult(null);
    try {
      setResult(
        await deployContract(
          {
            contractPath,
            name,
            core,
            rpcBase,
            seed: o.seed,
            dynCallees,
            skipVerify: "skip-verify" in o,
            compiler: resolveCompiler(o),
          },
          emit,
        ),
      );
    } catch (e: any) {
      setNotes((n) => [...n, "ERROR: " + String(e?.message ?? e)]);
    }
    try {
      setContracts(await nodeContracts(rpcBase));
    } catch {}
    setRuns((n) => n + 1);
    busyRef.current = false;
    setBusy(false);
    if (pending.current) {
      pending.current = false;
      redeploy();
    }
  };

  useEffect(() => {
    if (coreErr) return;
    redeploy();
    // Poll mtimes (fs.watch doesn't fire in the --compile binary; a timer does).
    const files = [contractPath, ...Object.values(dynCallees).map((c) => c.header)];
    const mtime = (f: string) => {
      try {
        return statSync(f).mtimeMs;
      } catch {
        return 0;
      }
    };
    const seen = new Map(files.map((f) => [f, mtime(f)]));
    let t: ReturnType<typeof setTimeout>;
    const iv = setInterval(() => {
      for (const f of files) {
        const m = mtime(f);
        if (m !== seen.get(f)) {
          seen.set(f, m);
          clearTimeout(t);
          t = setTimeout(redeploy, 300);
        }
      }
    }, 700);
    return () => {
      clearInterval(iv);
      clearTimeout(t);
    };
  }, []);
  // Live node heartbeat — drives the tick counter + up/down dot in the status card.
  useEffect(() => {
    const rpc = new LiteRpc(rpcBase);
    const ping = async () => {
      try {
        const ti: any = await rpc.tickInfo();
        setTick(ti.tick ?? ti.currentTick ?? null);
      } catch {
        setTick(null);
      }
    };
    ping();
    const iv = setInterval(ping, 1500);
    return () => clearInterval(iv);
  }, []);
  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) exit();
    },
    { isActive: !!process.stdin.isTTY },
  );

  if (coreErr)
    return (
      <Box flexDirection="column">
        <Header cmd="dev" />
        <Panel title="no core headers" color={theme.err}>
          <Text>{coreErr}</Text>
        </Panel>
      </Box>
    );

  const ok = result?.ok;
  const runNo = busy ? runs + 1 : runs;
  const lastText = result
    ? ok
      ? "armed ✓"
      : `failed: ${result.reason ?? result.error ?? "?"}`
    : busy
      ? "deploying…"
      : "idle";
  const lastColor = ok ? theme.ok : result ? theme.err : busy ? theme.info : theme.mute;
  const live = tick != null;
  const pipeColor = busy ? theme.info : ok ? theme.ok : result ? theme.err : theme.info;
  const isErr = (n: string) => /^(✗|⚠|ERROR)/.test(n);

  return (
    <Box flexDirection="column">
      <Header cmd="dev" />

      <Panel title="watch" color={theme.brand}>
        <Text>
          <Text bold color={theme.accent}>
            ◆ {name}
          </Text>
          {"   "}
          <Text dimColor>{basename(contractPath)}</Text>
        </Text>
        <Box>
          <Text>
            run <Text bold>#{runNo}</Text>
            {"   "}
          </Text>
          <Text bold color={lastColor}>
            {lastText}
          </Text>
          <Text dimColor>{"   ·   "}</Text>
          <Text color={live ? theme.ok : theme.err}>{live ? "●" : "○"}</Text>
          <Text dimColor> {live ? `tick ${tick}` : "node down"}</Text>
        </Box>
        <Text dimColor>
          rpc {rpcBase.replace(/^https?:\/\//, "")}
          {"   ·   "}
          <Text bold color={theme.accent}>
            q
          </Text>{" "}
          quit
        </Text>
      </Panel>

      <Box marginTop={1}>
        <Panel title={busy ? `run #${runNo}  …` : "pipeline"} color={pipeColor}>
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
        </Panel>
      </Box>

      {notes.length > 0 && (
        <Box marginTop={1}>
          <Panel title="notes" color={theme.warn}>
            {notes.slice(-4).map((n, i) => (
              <Text key={i} color={isErr(n) ? theme.err : undefined} dimColor={!isErr(n)}>
                {n}
              </Text>
            ))}
          </Panel>
        </Box>
      )}

      <Box marginTop={1}>
        <Panel title={`armed (${contracts.length})`} color={theme.info}>
          {contracts.length ? (
            contracts.map((c, i) => (
              <Text key={i}>
                <Text color={theme.ok}>●</Text> {c}
              </Text>
            ))
          ) : (
            <Text dimColor>none yet — deploy to arm</Text>
          )}
        </Panel>
      </Box>
    </Box>
  );
}
