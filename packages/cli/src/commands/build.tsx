import { useEffect, useState } from "react";
import { resolve, join } from "node:path";
import { writeFileSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContract, type BuildResult } from "@qinit/build";
import { loadConfig } from "../config";

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
    const cfg = loadConfig();
    const core = o.core ?? cfg.core ?? process.env.QINIT_CORE ?? "/home/kali/Projects/qubic-core-lite";
    const name = o.name ?? cfg.name ?? "Counter";
    const outDir = resolve(o.out ?? "dist/contracts");
    buildContract({
      contractPath: resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h"),
      name, slot: Number(o.slot ?? cfg.slot ?? 28), corePath: core, outDir,
    }).then((r) => {
      if (r.ok && r.idl) try { writeFileSync(join(outDir, `${name}.idl.json`), JSON.stringify(r.idl, null, 2)); } catch {}
      setS({ phase: "done", r });
    });
  }, []);
  useEffect(() => {
    if (s.phase === "done") { process.exitCode = s.r.ok ? 0 : 1; exit(); }
  }, [s, exit]);

  if (s.phase === "run") return <Text>compiling contract .so …</Text>;
  const { r } = s;
  if (!r.ok) {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ build failed</Text>
        <Text dimColor>{(r.stderr ?? "").split("\n").slice(0, 25).join("\n")}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="green">✓ built {r.so}</Text>
      <Text dimColor>size: {r.size} bytes</Text>
      <Text dimColor>k12:  {r.hash ?? "(pending)"}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>unresolved QPI symbols ({r.undef?.length ?? 0}) — forwarders still needed:</Text>
        {(r.undef ?? []).slice(0, 40).map((u, i) => (
          <Text key={i} dimColor>  {u}</Text>
        ))}
        {(r.undef?.length ?? 0) === 0 && <Text color="green">  none — minimal ABI satisfies this contract</Text>}
      </Box>
      {r.idl && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>IDL ({r.idl.name}) — wrote {r.idl.name}.idl.json:</Text>
          {Object.entries(r.idl.functions).map(([it, e]) => (
            <Text key={"f" + it} dimColor>  fn   {e.name}  #{it}  in='{e.in}' out='{e.out}'</Text>
          ))}
          {Object.entries(r.idl.procedures).map(([it, e]) => (
            <Text key={"p" + it} dimColor>  proc {e.name}  #{it}  in='{e.in}'</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
