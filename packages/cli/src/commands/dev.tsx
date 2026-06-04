import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { resolve, basename } from "node:path";
import { statSync } from "node:fs";
import { loadConfig, resolveCore } from "../config";
import { deployContract, STEPS, type Ev, type DeployResult } from "../deploy-ops";
import { nodeContracts } from "../node-ops";
import { Header, StepRow, type StepState, Panel, theme } from "../ui";

interface SS { state: StepState; detail?: string; pct?: number; startedAt?: number; elapsedMs?: number }

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}

export function Dev({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const cfg = loadConfig();
  const rpcBase = o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841";
  const contractPath = resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h");
  const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
  const dynCallees: Record<string, { header: string; index: number }> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--callee") continue;
    const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
    if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
  }
  let core = "", coreErr = "";
  try { core = resolveCore(o.core, cfg.core); } catch (e: any) { coreErr = String(e?.message ?? e); }

  const [steps, setSteps] = useState<Record<string, SS>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [contracts, setContracts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState(0);
  const busyRef = useRef(false);
  const pending = useRef(false);

  const emit = (e: Ev) => {
    if ("note" in e) { setNotes((n) => [...n, e.note]); return; }
    setSteps((s) => {
      const prev = s[e.step] ?? {} as SS;
      const startedAt = e.state === "active" && !prev.startedAt ? Date.now() : prev.startedAt;
      const elapsedMs = (e.state === "ok" || e.state === "fail") && startedAt ? Date.now() - startedAt : prev.elapsedMs;
      return { ...s, [e.step]: { state: e.state, detail: e.detail ?? prev.detail, pct: e.pct ?? prev.pct, startedAt, elapsedMs } };
    });
  };

  const redeploy = async () => {
    if (busyRef.current) { pending.current = true; return; }
    busyRef.current = true; setBusy(true);
    setSteps({}); setNotes([]); setResult(null);
    try { setResult(await deployContract({ contractPath, name, core, rpcBase, seed: o.seed, dynCallees }, emit)); }
    catch (e: any) { setNotes((n) => [...n, "ERROR: " + String(e?.message ?? e)]); }
    try { setContracts(await nodeContracts(rpcBase)); } catch {}
    setRuns((n) => n + 1);
    busyRef.current = false; setBusy(false);
    if (pending.current) { pending.current = false; redeploy(); }
  };

  useEffect(() => {
    if (coreErr) return;
    redeploy();
    // Poll mtimes (fs.watch doesn't fire in the --compile binary; a timer does).
    const files = [contractPath, ...Object.values(dynCallees).map((c) => c.header)];
    const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
    const seen = new Map(files.map((f) => [f, mtime(f)]));
    let t: ReturnType<typeof setTimeout>;
    const iv = setInterval(() => {
      for (const f of files) { const m = mtime(f); if (m !== seen.get(f)) { seen.set(f, m); clearTimeout(t); t = setTimeout(redeploy, 300); } }
    }, 700);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, []);
  useInput((input, key) => { if (input === "q" || (key.ctrl && input === "c")) exit(); }, { isActive: !!process.stdin.isTTY });

  if (coreErr) return <Box flexDirection="column"><Header cmd="dev" /><Panel title="no core headers" color={theme.err}><Text>{coreErr}</Text></Panel></Box>;

  const last = result ? (result.ok ? "armed ✓" : `✗ ${result.reason ?? "failed"}`) : busy ? "deploying…" : "—";
  return (
    <Box flexDirection="column">
      <Header cmd="dev" />
      <Text dimColor>
        watching <Text color={theme.accent}>{name}</Text> ({basename(contractPath)}) · run #{runs} · last{" "}
        <Text color={result?.ok ? theme.ok : result ? theme.err : undefined}>{last}</Text> · <Text bold>q</Text> quit
      </Text>
      <Box marginTop={1} flexDirection="column">
        {STEPS.map(({ key, label }) => {
          const s = steps[key] ?? { state: "pending" as StepState };
          return <StepRow key={key} state={s.state} label={label} detail={s.detail} pct={s.pct} elapsedMs={s.elapsedMs} />;
        })}
      </Box>
      {notes.length > 0 && <Box marginTop={1} flexDirection="column">{notes.slice(-4).map((n, i) => <Text key={i} color={/^[✗⚠E]/.test(n) ? theme.err : undefined} dimColor={!/^[✗⚠E]/.test(n)}>{n}</Text>)}</Box>}
      <Box marginTop={1}><Panel title={`armed (${contracts.length})`} color={theme.info}><Text>{contracts.length ? contracts.join(", ") : "(none)"}</Text></Panel></Box>
    </Box>
  );
}
