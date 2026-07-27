import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_PEER_PORT,
  DEFAULT_RPC_BASE,
  LOOPBACK_HOST,
  fetchWasiSdk,
  haveWasiSdkCache,
  loadCoreWasmSlotLayout,
} from "@qinit/core";
import {
  fetchNodeBinary,
  cachedNode,
  nodeStatus,
  nodeContracts,
  killNode,
  launchNode,
  launchSimulatorNode,
  waitTicking,
} from "../node-ops";
import { loadConfig, resolveNodeBackend } from "../config";
import { Header, Step, type StepState, Panel, KV, theme } from "../ui";
import { parseCommandArgs, output } from "../args";
import { prepareNodeRunCore } from "../node-run-core";

type Phase = { key: string; label: string; state: StepState; detail?: string };

export function NodeRun({ args }: { args: string[] }) {
  const { exit } = useApp();
  const { flags: o } = parseCommandArgs("node", args, "run");
  const rpcBaseUrl = o.rpc || DEFAULT_RPC_BASE;
  const peerPort = Number(o["peer-port"] || DEFAULT_PEER_PORT);
  const ref = o.ref || "latest";
  const useSimulator = resolveNodeBackend(o) === "simulator";
  const [steps, setSteps] = useState<Phase[]>([
    { key: "headers", label: "core headers", state: "pending" },
    { key: "node", label: "node binary", state: "pending" },
    { key: "wasi-sdk", label: "wasm compiler", state: "pending" },
    { key: "run", label: "node running", state: "pending" },
  ]);
  const [done, setDone] = useState<{
    ok: boolean;
    title: string;
    color: string;
    rows: [string, string][];
  } | null>(null);
  const set = (key: string, state: StepState, detail?: string) =>
    setSteps((ps) =>
      ps.map((p) => (p.key === key ? { ...p, state, detail: detail ?? p.detail } : p)),
    );

  useEffect(() => {
    (async () => {
      try {
        // An explicit core checkout bypasses the release manifest.
        set("headers", "active");
        const preparedCore = await prepareNodeRunCore(o, useSimulator);
        const { version, coreHeaders: currentHeaders } = preparedCore;
        set("headers", "ok", preparedCore.detail);
        const slotLayout = useSimulator ? loadCoreWasmSlotLayout(currentHeaders) : undefined;
        if (useSimulator && !slotLayout) {
          throw new Error("simulator requires synced core headers for its Wasm slot layout");
        }

        // Node binary: not needed for the simulator backend; otherwise
        // reuse cached, else fetch (fetchNodeBinary skips download if already cached).
        set("node", "active");
        let nodeBinary = "";
        if (useSimulator) {
          set("node", "ok", "simulator — no binary");
        } else if (o["node-bin"]) {
          nodeBinary = resolve(o["node-bin"]);
          if (!existsSync(nodeBinary)) {
            throw new Error(`--node-bin not found: ${nodeBinary}`);
          }
          set("node", "ok", `local ${nodeBinary}`);
        } else if ("offline" in o) {
          const c = cachedNode();
          if (!c) throw new Error("offline: no cached node — run `qinit node run` online first");
          nodeBinary = c;
          set("node", "ok", "reuse cached");
        } else {
          nodeBinary = (await fetchNodeBinary(ref)).nodeBinaryPath;
          set("node", "ok", `ready ${version}`);
        }

        // wasm compiler: fetch the host's wasi-sdk (clang + wasi-sysroot) so `qinit build` needs zero
        // native deps. Best-effort — WASM_CLANG/WASI_SYSROOT or a clang on PATH still work.
        set("wasi-sdk", "active");
        try {
          if ("offline" in o)
            set("wasi-sdk", "ok", haveWasiSdkCache() ? "cached" : "offline — skipped");
          else {
            const s = await fetchWasiSdk((rc, tt) =>
              set(
                "wasi-sdk",
                "active",
                tt ? `${(rc / 1e6) | 0}/${(tt / 1e6) | 0} MB` : `${(rc / 1e6) | 0} MB`,
              ),
            );
            set("wasi-sdk", "ok", s.cached ? "cached" : "fetched");
          }
        } catch {
          set("wasi-sdk", "ok", "unavailable — set WASM_CLANG/WASI_SYSROOT");
        }

        // Run: reuse a node that's already ticking (keeps deployed state); else (re)launch.
        set("run", "active", "checking");
        const st = await nodeStatus(rpcBaseUrl);
        let scratch = "",
          ok: boolean,
          tick: number;
        if (st.up && st.ticking && !("restart" in o)) {
          ok = true;
          tick = st.tick;
          set("run", "ok", `reused, ticking at ${tick}`);
        } else {
          const why = !st.up ? "no node" : st.ticking ? "--restart" : "node idle";
          set("run", "active", `${why} → launching${useSimulator ? " simulator" : ""}`);
          await killNode();
          const launched = useSimulator
            ? launchSimulatorNode({
                scratchDirectory: o["scratch-dir"],
                rpcBaseUrl: rpcBaseUrl,
                peerPort,
                preserveScratchContents: o.keep !== undefined,
                tickMs: o["tick-ms"] !== undefined ? Number(o["tick-ms"]) : undefined,
                system: loadConfig().system,
                slotBase: slotLayout!.slotBase,
                slotCount: slotLayout!.slotCount,
              })
            : launchNode({
                nodeBinary,
                scratchDirectory: o["scratch-dir"],
                nodeMode: o["node-mode"],
                peers: o.peers,
                preserveScratchContents: o.keep !== undefined,
              });
          scratch = launched.scratch;
          const w = await waitTicking(rpcBaseUrl, Number(o.wait || 90));
          ok = w.ticking;
          tick = w.tick;
          if (w.ticking) {
            set("run", "ok", `launched pid ${launched.pid}, ticking at ${tick}`);
          }
          else
            set(
              "run",
              "fail",
              w.exited ? "exited early — see node.log" : "not ticking — see node.log",
            );
        }

        // Trust the run verdict above; just read contracts once (no extra tick sampling).
        const contracts = await nodeContracts(rpcBaseUrl);
        const rows: [string, string][] = [
          ["backend", useSimulator ? "simulator (in-process)" : "core-lite node"],
          ["version", version],
          ["rpc", rpcBaseUrl],
          ["tick", String(tick)],
          ["contracts", contracts.length ? contracts.join(", ") : "(none)"],
        ];
        if (useSimulator) rows.splice(3, 0, ["peer", `${LOOPBACK_HOST}:${peerPort}`]);
        if (scratch) rows.push(["scratch", scratch]);
        setDone({
          ok,
          title: ok ? "node up ✓" : "node not ticking",
          color: ok ? theme.ok : theme.warn,
          rows,
        });
      } catch (e: any) {
        setSteps((ps) => ps.map((p) => (p.state === "active" ? { ...p, state: "fail" } : p)));
        setDone({
          ok: false,
          title: "node run failed",
          color: theme.err,
          rows: [["error", String(e?.message ?? e)]],
        });
      }
    })();
  }, []);
  useEffect(() => {
    if (done) {
      if (output.json)
        process.stdout.write(
          JSON.stringify({ ok: done.ok, ...Object.fromEntries(done.rows) }) + "\n",
        );
      process.exitCode = done.ok ? 0 : 1;
      const t = setTimeout(() => exit(), 50);
      return () => clearTimeout(t);
    }
  }, [done]);

  if (output.json) return null;
  return (
    <Box flexDirection="column">
      <Header cmd="node run" />
      {steps.map((p) => (
        <Step key={p.key} state={p.state} label={p.label} detail={p.detail} />
      ))}
      {done && (
        <Box marginTop={1}>
          <Panel title={done.title} color={done.color}>
            <KV rows={done.rows} />
          </Panel>
        </Box>
      )}
    </Box>
  );
}
