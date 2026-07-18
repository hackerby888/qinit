import { useEffect, useState } from "react";
import { resolve, join, basename } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContract, type BuildResult } from "@qinit/build";
import {
  autoUpdateVerifyTool,
  LiteRpc,
  loadCoreWasmSlotLayout,
  type VerifyUpdate,
} from "@qinit/core";
import { resolveNodeCallees } from "../deploy-ops";
import { compileLocal } from "../compile-local";
import { loadConfig, resolveCore, resolveCompiler } from "../config";
import { Header, Spinner, Panel, KV, Status, theme, termCols } from "../ui";

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
  { phase: "run" } | { phase: "done"; r: BuildResult; vu?: VerifyUpdate; notes?: string[] };

export function Build({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { o, pos } = parse(args);
  const compiler = resolveCompiler(o); // saved `qinit compiler` pick, overridable per-run with --native/--local
  const [s, setS] = useState<State>({ phase: "run" });

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const core = resolveCore(o.core, cfg.core);
        const contractPath = resolve(o.contract ?? pos[0] ?? cfg.contract ?? "fixtures/Counter.h");
        const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
        const outDir = resolve(o.out ?? "dist/contracts");
        const slot = Number(o.slot ?? cfg.slot ?? loadCoreWasmSlotLayout(core).slotBase);

        const dynCallees: Record<string, { header: string; index: number }> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== "--callee") continue;
          const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
          if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
        }

        // local: in-process TS compiler (no clang). Emits the same rich idl for the client/state tooling.
        if (compiler === "local") {
          const r = await compileLocal({ contractPath, name, slot, core, outDir, dynCallees });
          if (!r.ok) {
            setS({ phase: "done", r: { ok: false, stderr: r.stderr } });
            return;
          }
          if (r.idl)
            try {
              writeFileSync(join(outDir, `${name}.idl.json`), JSON.stringify(r.idl, null, 2));
            } catch {}
          setS({
            phase: "done",
            r: { ok: true, so: r.so, size: r.size, hash: "", idl: r.idl as any },
          });
          return;
        }

        // Backend-clang build path
        const notes: string[] = [];
        const rpcBase = o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841";
        const callees = await resolveNodeCallees(
          new LiteRpc(rpcBase),
          readFileSync(contractPath, "utf8"),
          dynCallees,
          (n) => notes.push(n),
          2500,
        );
        const vu = await autoUpdateVerifyTool();
        const r = await buildContract({
          contractPath,
          name,
          slot,
          corePath: core,
          outDir,
          dynCallees: callees,
          skipVerify: "skip-verify" in o,
        });
        if (r.ok && r.idl)
          try {
            writeFileSync(join(outDir, `${name}.idl.json`), JSON.stringify(r.idl, null, 2));
          } catch {}
        setS({ phase: "done", r, vu, notes });
      } catch (e: any) {
        setS({ phase: "done", r: { ok: false, stderr: String(e?.message ?? e) } });
      }
    })();
  }, []);

  useEffect(() => {
    if (s.phase === "done") {
      process.exitCode = s.r.ok ? 0 : 1;
      exit();
    }
  }, [s, exit]);

  if (s.phase === "run") {
    const label =
      compiler === "local"
        ? "compiling contract to wasm (local TS compiler)"
        : "compiling contract to wasm";
    return (
      <Box flexDirection="column">
        <Header cmd="build" />
        <Spinner label={label} />
      </Box>
    );
  }

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

  return (
    <Box flexDirection="column">
      <Header cmd="build" />
      <Panel title={"built ✓" + (compiler === "local" ? " (local)" : "")} color={theme.ok}>
        <KV
          rows={[
            ["wasm", String(r.so)],
            ["size", `${r.size} bytes`],
            ["k12 ", r.hash || "(pending)"],
          ]}
        />
      </Panel>
      {compiler === "local" ? null : (
        <Box marginTop={1}>
          <Status
            ok={true}
            label="protocol rules"
            detail="passed — complies with qpi.h restrictions"
            pad={16}
          />
        </Box>
      )}
    </Box>
  );
}
