import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractIdl, generateClient } from "@qinit/build";
import { loadConfig } from "../config";
import { Header, Panel, KV, theme } from "../ui";

// qinit gen [--contract <path>] [--name] [--slot] [--out <dir>]
// Generate a typed TS client (interfaces + a class over callFunction/invokeProcedure) from the contract.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i] ?? "";
  return o;
}

type State = { ok: true; file: string; name: string; slot: number; fns: number; procs: number } | { ok: false; err: string } | null;

export function Gen({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const [s, setS] = useState<State>(null);

  useEffect(() => {
    try {
      const cfg = loadConfig();
      const contractPath = resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h");
      const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
      const slot = Number(o.slot ?? cfg.slot ?? 28);
      const idl = extractIdl(readFileSync(contractPath, "utf8"), name);
      const ts = generateClient(idl, slot);
      const outDir = resolve(o.out ?? "dist/clients");
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `${name}.ts`);
      writeFileSync(file, ts);
      setS({ ok: true, file, name, slot, fns: Object.keys(idl.functions).length, procs: Object.keys(idl.procedures).length });
    } catch (e: any) { setS({ ok: false, err: String(e?.message ?? e) }); }
  }, []);
  useEffect(() => { if (s) { process.exitCode = s.ok ? 0 : 1; exit(); } }, [s, exit]);

  return (
    <Box flexDirection="column">
      <Header cmd="gen" />
      {s?.ok && (
        <Panel title="client generated ✓" color={theme.ok}>
          <KV rows={[["contract", s.name], ["slot", String(s.slot)], ["fns/procs", `${s.fns} / ${s.procs}`], ["file", s.file]]} />
          <Box marginTop={1}><Text dimColor>import {`{ ${s.name} }`} from "{s.file.replace(/\.ts$/, "")}"</Text></Box>
        </Panel>
      )}
      {s && !s.ok && <Panel title="gen failed" color={theme.err}><Text dimColor>{s.err}</Text></Panel>}
    </Box>
  );
}
