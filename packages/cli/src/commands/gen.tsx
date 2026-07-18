import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { resolve, join, basename } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractIdl, generateClient, qpiPrelude, testRuntimeSource } from "@qinit/build";
import { DEFAULT_WASM_SLOT_LAYOUT, loadCoreWasmSlotLayout } from "@qinit/core";
import { loadConfig, resolveCore } from "../config";
import { Header, Panel, KV, theme } from "../ui";

// qinit gen [--contract <path>] [--name] [--slot] [--out <dir>]
// Generate a typed TS client (interfaces + a class over callFunction/invokeProcedure) from the contract.
function parse(args: string[]): { o: Record<string, string>; pos: string[] } {
  const o: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--"))
      o[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "";
    else pos.push(args[i]);
  }
  return { o, pos };
}

type State =
  | { ok: true; file: string; name: string; slot: number; fns: number; procs: number }
  | { ok: false; err: string }
  | null;

export function Gen({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { o, pos } = parse(args);
  const [s, setS] = useState<State>(null);

  useEffect(() => {
    try {
      const cfg = loadConfig();
      const contractPath = resolve(o.contract ?? pos[0] ?? cfg.contract ?? "fixtures/Counter.h");
      const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
      let core: string | undefined;
      try {
        core = resolveCore(o.core, cfg.core);
      } catch {
        core = undefined;
      }
      const defaultSlot = core
        ? loadCoreWasmSlotLayout(core).slotBase
        : DEFAULT_WASM_SLOT_LAYOUT.slotBase;
      const slot = Number(o.slot ?? cfg.slot ?? defaultSlot);
      let prelude: string | undefined;
      try {
        prelude = core ? qpiPrelude(core) : undefined;
      } catch {
        prelude = undefined;
      } // resolve qpi library types; degrade if core unavailable
      const idl = extractIdl(readFileSync(contractPath, "utf8"), name, { prelude });
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
        fns: Object.keys(idl.functions).length,
        procs: Object.keys(idl.procedures).length,
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
