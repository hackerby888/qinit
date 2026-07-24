import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractIdl, generateClient, testRuntimeSource } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compile";
import { loadCoreWasmSlotLayout } from "@qinit/core";
import { loadConfig, resolveCore } from "../config";
import { Header, Panel, KV, theme } from "../ui";
import { parseArgs } from "../args";

type State =
  | { ok: true; file: string; name: string; slot: number; fns: number; procs: number }
  | { ok: false; err: string }
  | null;

export function Gen({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { flags: o, pos } = parseArgs(args, {
    strings: ["contract", "name", "slot", "out", "core"],
  });
  const [s, setS] = useState<State>(null);

  useEffect(() => {
    try {
      const cfg = loadConfig();
      const contractPath = resolve(o.contract ?? pos[0] ?? cfg.contract ?? "fixtures/Counter.h");
      const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
      const core = resolveCore(o.core, cfg.core);
      const defaultSlot = loadCoreWasmSlotLayout(core).slotBase;
      const slot = Number(o.slot ?? cfg.slot ?? defaultSlot);
      const idl = extractIdl(readFileSync(contractPath, "utf8"), name, {
        slot,
        qpiHeader: loadQpiHeader(core),
      });
      // Emit a SELF-CONTAINED client: the client pulls LiteRpc/codec from a sibling runtime.ts (only needs the
      // public @qubic-lib), not from the unpublished @qinit/* monorepo packages — so the output works outside it.
      const ts = generateClient(idl, slot, { runtimeImport: "./runtime" });
      const outDir = resolve(o.out ?? "dist/clients");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "runtime.ts"), testRuntimeSource);
      const file = join(outDir, `${name}.ts`);
      writeFileSync(file, ts);
      setS({
        ok: true,
        file,
        name,
        slot,
        fns: idl.functions.length,
        procs: idl.procedures.length,
      });
    } catch (e: any) {
      setS({ ok: false, err: String(e?.message ?? e) });
    }
  }, []);
  useEffect(() => {
    if (s) {
      process.exitCode = s.ok ? 0 : 1;
      exit();
    }
  }, [s, exit]);

  return (
    <Box flexDirection="column">
      <Header cmd="gen" />
      {s?.ok && (
        <Panel title="client generated ✓" color={theme.ok}>
          <KV
            rows={[
              ["contract", s.name],
              ["slot", String(s.slot)],
              ["fns/procs", `${s.fns} / ${s.procs}`],
              ["file", s.file],
            ]}
          />
          <Box marginTop={1}>
            <Text dimColor>
              import {`{ ${s.name} }`} from "{s.file.replace(/\.ts$/, "")}"
            </Text>
          </Box>
        </Panel>
      )}
      {s && !s.ok && (
        <Panel title="gen failed" color={theme.err}>
          <Text dimColor>{s.err}</Text>
        </Panel>
      )}
    </Box>
  );
}
