import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { resolve, basename } from "node:path";
import { statSync } from "node:fs";
import { loadConfig, resolveCore } from "../config";
import { deployContract } from "../deploy-ops";
import { nodeContracts } from "../node-ops";
import { Header, Spinner, Panel, theme } from "../ui";

// qinit dev [--contract] [--name] [--seed] [--rpc] [--callee ...]
// Watch the contract (+ callee headers) -> auto build+deploy on save -> show registry. q to quit.
// No subcommand for `dev` — parse from i=0 (unlike `node <sub>` which skips args[0]).
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

  const [logLines, setLogLines] = useState<string[]>([]);
  const [contracts, setContracts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState(0);
  const busyRef = useRef(false);
  const pending = useRef(false);

  const redeploy = async () => {
    if (busyRef.current) { pending.current = true; return; } // coalesce saves during a deploy
    busyRef.current = true; setBusy(true);
    const lines: string[] = [];
    setLogLines([]);
    try {
      await deployContract({ contractPath, name, core, rpcBase, seed: o.seed, dynCallees }, (s) => { lines.push(s); setLogLines([...lines]); });
    } catch (e: any) { lines.push("ERROR: " + String(e?.message ?? e)); setLogLines([...lines]); }
    try { setContracts(await nodeContracts(rpcBase)); } catch {}
    setRuns((n) => n + 1);
    busyRef.current = false; setBusy(false);
    if (pending.current) { pending.current = false; redeploy(); } // a save arrived mid-deploy
  };

  useEffect(() => {
    if (coreErr) return;
    redeploy(); // initial deploy
    // Poll mtimes via setInterval: fs.watch/watchFile don't deliver events in the --compile binary,
    // but a plain timer does (same mechanism the spinner uses). Robust to editors' rename-on-save.
    const files = [contractPath, ...Object.values(dynCallees).map((c) => c.header)];
    const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
    const seen = new Map(files.map((f) => [f, mtime(f)]));
    let t: ReturnType<typeof setTimeout>;
    const iv = setInterval(() => {
      for (const f of files) { const m = mtime(f); if (m !== seen.get(f)) { seen.set(f, m); clearTimeout(t); t = setTimeout(redeploy, 300); } }
    }, 700);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, []);
  // isActive TTY-only: useInput enables stdin raw mode, which throws in a non-TTY (piped/CI).
  useInput((input, key) => { if (input === "q" || (key.ctrl && input === "c")) exit(); }, { isActive: !!process.stdin.isTTY });

  if (coreErr) return <Box flexDirection="column"><Header cmd="dev" /><Panel title="no core headers" color={theme.err}><Text>{coreErr}</Text></Panel></Box>;

  return (
    <Box flexDirection="column">
      <Header cmd="dev" />
      <Text dimColor>watching <Text color={theme.accent}>{name}</Text> ({basename(contractPath)}) · {rpcBase} · runs {runs} · <Text bold>q</Text> to quit</Text>
      <Box marginTop={1} flexDirection="column">
        {logLines.slice(-8).map((l, i) => (
          <Text key={i} color={l.startsWith("✗") || l.startsWith("ERROR") ? theme.err : l.includes("idl ->") || l.includes("(past deploy)") ? theme.ok : undefined} dimColor={l.startsWith("  ")}>{l}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        {busy
          ? <Spinner label="deploying" />
          : <Panel title={`armed (${contracts.length})`} color={theme.info}><Text>{contracts.length ? contracts.join(", ") : "(none)"}</Text></Panel>}
      </Box>
    </Box>
  );
}
