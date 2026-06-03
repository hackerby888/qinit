import { useEffect, useState } from "react";
import { resolve, join, basename } from "node:path";
import { writeFileSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContract, type BuildResult } from "@qinit/build";
import { loadConfig, resolveCore } from "../config";
import { Header, Spinner, Panel, KV, Status, theme } from "../ui";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? "";
  }
  return o;
}

type State = { phase: "run" } | { phase: "done"; r: BuildResult };

export function Build({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const [s, setS] = useState<State>({ phase: "run" });

  useEffect(() => {
    try {
      const cfg = loadConfig();
      const core = resolveCore(o.core, cfg.core);
      const contractPath = resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h");
      // Name derived from the contract filename (Counter.h -> Counter); --name / cfg.name override.
      const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
      const outDir = resolve(o.out ?? "dist/contracts");
      // Inter-contract: repeatable --callee Name=/abs/header.h@slot (mirrors deploy).
      const dynCallees: Record<string, { header: string; index: number }> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--callee") continue;
        const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
        if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
      }
      buildContract({
        contractPath,
        name, slot: Number(o.slot ?? cfg.slot ?? 28), corePath: core, outDir, dynCallees,
      }).then((r) => {
        if (r.ok && r.idl) try { writeFileSync(join(outDir, `${name}.idl.json`), JSON.stringify(r.idl, null, 2)); } catch {}
        setS({ phase: "done", r });
      });
    } catch (e: any) {
      setS({ phase: "done", r: { ok: false, stderr: String(e?.message ?? e) } });
    }
  }, []);
  useEffect(() => {
    if (s.phase === "done") { process.exitCode = s.r.ok ? 0 : 1; exit(); }
  }, [s, exit]);

  if (s.phase === "run") return <Box flexDirection="column"><Header cmd="build" /><Spinner label="compiling contract .so" /></Box>;
  const { r } = s;
  if (!r.ok) {
    return (
      <Box flexDirection="column">
        <Header cmd="build" />
        <Panel title="build failed" color={theme.err}>
          <Text dimColor>{(r.stderr ?? "").split("\n").slice(0, 25).join("\n")}</Text>
        </Panel>
      </Box>
    );
  }
  const undef = r.undef ?? [];
  return (
    <Box flexDirection="column">
      <Header cmd="build" />
      <Panel title="built ✓" color={theme.ok}>
        <KV rows={[
          [".so ", String(r.so)],
          ["size", `${r.size} bytes`],
          ["k12 ", r.hash ?? "(pending)"],
        ]} />
      </Panel>
      <Box marginTop={1}>
        {undef.length === 0
          ? <Status ok={true} label="QPI symbols" detail="none unresolved — minimal ABI satisfies this contract" pad={12} />
          : (
            <Box flexDirection="column">
              <Status ok={false} label="QPI symbols" detail={`${undef.length} unresolved — forwarders still needed`} pad={12} />
              {undef.slice(0, 40).map((u, i) => <Text key={i} dimColor>  {u}</Text>)}
            </Box>
          )}
      </Box>
      {r.idl && (
        <Box marginTop={1}>
          <Panel title={`IDL · ${r.idl.name}`} color={theme.info}>
            {Object.entries(r.idl.functions).map(([it, e]) => (
              <Text key={"f" + it}><Text color={theme.info}>fn  </Text> <Text bold>{e.name}</Text> <Text dimColor>#{it}  in='{e.in}' out='{e.out}'</Text></Text>
            ))}
            {Object.entries(r.idl.procedures).map(([it, e]) => (
              <Text key={"p" + it}><Text color={theme.accent}>proc</Text> <Text bold>{e.name}</Text> <Text dimColor>#{it}  in='{e.in}'</Text></Text>
            ))}
          </Panel>
        </Box>
      )}
    </Box>
  );
}
