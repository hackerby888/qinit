import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { Box, Text, useApp } from "ink";
import { loadConfig, resolveCore } from "../config";
import { deployContract } from "../deploy-ops";
import { Header, Spinner, Step, type StepState, theme } from "../ui";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i] ?? "";
  return o;
}

// Derive a 6-phase pipeline from the append-only log (log strings are stable; unknown -> pending).
type Phase = { key: string; label: string; state: StepState; detail?: string };
function deriveSteps(log: string[]): Phase[] {
  const P: Phase[] = [
    { key: "tick", label: "node ticking", state: "pending" },
    { key: "slot", label: "resolve slot", state: "pending" },
    { key: "build", label: "build .so", state: "pending" },
    { key: "upload", label: "upload chunks", state: "pending" },
    { key: "deploy", label: "deploy", state: "pending" },
    { key: "confirm", label: "confirm", state: "pending" },
  ];
  const set = (k: string, s: StepState, d?: string) => { const p = P.find((x) => x.key === k)!; p.state = s; if (d !== undefined) p.detail = d; };
  for (const l of log) {
    if (l.startsWith("waiting for node")) set("tick", "active");
    else if (l.includes("not ticking")) set("tick", "fail");
    else if (/^node ticking at \d+$/.test(l)) set("tick", "ok", l.replace("node ticking at ", "tick "));
    if (l.includes("→ slot")) set("slot", "ok", l.slice(l.indexOf("→") + 1).trim());
    if (l.startsWith("building .so")) set("build", "active");
    else if (l.startsWith("built ")) set("build", "ok", l.slice(6));
    else if (l.includes("build failed")) set("build", "fail");
    if (l.startsWith("uploads broadcast:")) { const m = l.match(/(\d+)\/(\d+) ok/); set("upload", m && m[1] === m[2] ? "ok" : "fail", m ? `${m[1]}/${m[2]}` : undefined); }
    if (l.startsWith("Deploy broadcast:")) set("deploy", l.includes("FAIL") ? "fail" : "ok", l.replace("Deploy broadcast: ", ""));
    if (l.startsWith("polling node")) set("confirm", "active");
    else if (l.includes("(past deploy)")) set("confirm", "ok");
    else if (l.includes("did not pass")) set("confirm", "fail");
    if (l.startsWith("ERROR")) { const a = P.find((x) => x.state === "active"); if (a) a.state = "fail"; }
  }
  return P;
}
function isPhaseLine(l: string): boolean {
  return /^waiting for node|not ticking|^node ticking at \d+$|→ slot|^building \.so|^built |build failed|^uploads broadcast:|^Deploy broadcast:|^polling node|\(past deploy\)|did not pass|^upload @tick/.test(l);
}

export function Deploy({ args }: { args: string[] }) {
  const o = parse(args);
  const { exit } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const contractPath = resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h");
        // Inter-contract: repeatable --callee Name=/abs/header.h@slot (dynamic callees, deployed earlier).
        const dynCallees: Record<string, { header: string; index: number }> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== "--callee") continue;
          const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
          if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
        }
        const sv = o.slot ?? cfg.slot;
        await deployContract({
          contractPath,
          name: o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, ""),
          core: resolveCore(o.core, cfg.core),
          rpcBase: o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841",
          seed: o.seed, dynCallees,
          slotOverride: sv !== undefined && sv !== "" ? Number(sv) : undefined,
        }, add);
        setDone(true);
      } catch (e: any) {
        add("ERROR: " + String(e?.stack ?? e?.message ?? e).slice(0, 300));
        setDone(true);
      }
    })();
  }, []);
  useEffect(() => { if (done) exit(); }, [done]);

  const steps = deriveSteps(log);
  const extras = log.filter((l) => !isPhaseLine(l));
  return (
    <Box flexDirection="column">
      <Header cmd="deploy" />
      <Box flexDirection="column">
        {steps.map((p) => <Step key={p.key} state={p.state} label={p.label} detail={p.detail} />)}
      </Box>
      {extras.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {extras.map((l, i) => (
            <Text key={i} color={l.startsWith("ERROR") ? theme.err : undefined} dimColor={!l.startsWith("ERROR")}>{l}</Text>
          ))}
        </Box>
      )}
      {!done && <Box marginTop={1}><Spinner label="working" /></Box>}
    </Box>
  );
}
