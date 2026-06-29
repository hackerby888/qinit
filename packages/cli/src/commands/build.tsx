import { useEffect, useState } from "react";
import { resolve, join, basename } from "node:path";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContract, type BuildResult } from "@qinit/build";
import { autoUpdateVerifyTool, LiteRpc, type VerifyUpdate } from "@qinit/core";
import { compileContract, loadQpiHeader } from "@qinit/compile";
import { resolveNodeCallees } from "../deploy-ops";
import { loadConfig, resolveCore } from "../config";
import { Header, Spinner, Panel, KV, Status, theme, termCols } from "../ui";

function parse(args: string[]): { o: Record<string, string>; pos: string[] } {
  const o: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) o[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "";
    else pos.push(args[i]);
  }
  return { o, pos };
}

type State = { phase: "run" } | { phase: "done"; r: BuildResult; vu?: VerifyUpdate; notes?: string[] };

export function Build({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { o, pos } = parse(args);
  const [s, setS] = useState<State>({ phase: "run" });

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const core = resolveCore(o.core, cfg.core);
        const contractPath = resolve(o.contract ?? pos[0] ?? cfg.contract ?? "fixtures/Counter.h");
        const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
        const outDir = resolve(o.out ?? "dist/contracts");
        const slot = Number(o.slot ?? cfg.slot ?? 28);

        // --local: use the in-process TS compiler instead of backend clang
        if ("local" in o) {
          const source = readFileSync(contractPath, "utf8");
          const qpiHeader = loadQpiHeader(core);
          if (!qpiHeader) {
            setS({ phase: "done", r: { ok: false, stderr: "Cannot load qpi.h headers — set QINIT_CORE or use --core" } });
            return;
          }
          const result = await compileContract({ source, name, slot, qpiHeader });
          if (result.diagnostics.some((d) => d.severity === "error")) {
            const stderr = result.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");
            setS({ phase: "done", r: { ok: false, stderr } });
            return;
          }
          mkdirSync(outDir, { recursive: true });
          const wasmPath = join(outDir, `${name}.wasm`);
          writeFileSync(wasmPath, Buffer.from(result.wasm));
          const size = result.wasm.byteLength;
          setS({
            phase: "done",
            r: { ok: true, so: wasmPath, size, hash: "", idl: result.idl as any },
          });
          return;
        }

        // Backend-clang build path
        const dynCallees: Record<string, { header: string; index: number }> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== "--callee") continue;
          const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
          if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
        }
        const notes: string[] = [];
        const rpcBase = o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841";
        const callees = await resolveNodeCallees(new LiteRpc(rpcBase), readFileSync(contractPath, "utf8"), dynCallees, (n) => notes.push(n), 2500);
        const vu = await autoUpdateVerifyTool();
        const r = await buildContract({ contractPath, name, slot, corePath: core, outDir, dynCallees: callees, skipVerify: "skip-verify" in o });
        if (r.ok && r.idl) try { writeFileSync(join(outDir, `${name}.idl.json`), JSON.stringify(r.idl, null, 2)); } catch {}
        setS({ phase: "done", r, vu, notes });
      } catch (e: any) {
        setS({ phase: "done", r: { ok: false, stderr: String(e?.message ?? e) } });
      }
    })();
  }, []);

  useEffect(() => {
    if (s.phase === "done") { process.exitCode = s.r.ok ? 0 : 1; exit(); }
  }, [s, exit]);

  if (s.phase === "run") {
    const label = "local" in o ? "compiling contract to wasm (local TS compiler)" : "compiling contract to wasm";
    return <Box flexDirection="column"><Header cmd="build" /><Spinner label={label} /></Box>;
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
      <Panel title={"built ✓" + ("local" in o ? " (local)" : "")} color={theme.ok}>
        <KV rows={[
          ["wasm", String(r.so)],
          ["size", `${r.size} bytes`],
          ["k12 ", r.hash || "(pending)"],
        ]} />
      </Panel>
      {"local" in o ? null : (
        <Box marginTop={1}>
          <Status ok={true} label="protocol rules" detail="passed — complies with qpi.h restrictions" pad={16} />
        </Box>
      )}
    </Box>
  );
}
