import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { existsSync } from "node:fs";
import { loadManifest, fetchVerify, extractTarGz, cacheHeaders, readCurrent, updateCurrent, fetchWasiSdk, haveWasiSdkCache } from "@qinit/core";
import { fetchNodeBin, cachedNode, nodeStatus, nodeContracts, killNode, launchNode, waitTicking } from "../node-ops";
import { Header, Step, type StepState, Panel, KV, theme } from "../ui";

// qinit up [--ref <tag>] [--restart] [--offline] [--rpc] [--wait]
// One command: sync headers + get node + run. Reuses a node that's already ticking (preserves
// deployed contracts); restarts only a stale/idle node or on --restart. Skips re-fetch when cached.
function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--restart" || a === "--offline") o[a.slice(2)] = "1";
    else if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? "";
  }
  return o;
}

type Phase = { key: string; label: string; state: StepState; detail?: string };

export function Up({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const rpcBase = o.rpc || "http://127.0.0.1:41841";
  const ref = o.ref || "latest";
  const [steps, setSteps] = useState<Phase[]>([
    { key: "headers", label: "core headers", state: "pending" },
    { key: "node", label: "node binary", state: "pending" },
    { key: "wasi-sdk", label: "wasm compiler", state: "pending" },
    { key: "run", label: "node running", state: "pending" },
  ]);
  const [done, setDone] = useState<{ title: string; color: string; rows: [string, string][] } | null>(null);
  const set = (key: string, state: StepState, detail?: string) =>
    setSteps((ps) => ps.map((p) => (p.key === key ? { ...p, state, detail: detail ?? p.detail } : p)));

  useEffect(() => {
    (async () => {
      try {
        // Resolve the version: online from the manifest, offline from the cache pointer.
        let version: string, headersAsset: any, nodeAsset: any;
        if (o.offline) {
          const cur = readCurrent();
          if (!cur?.coreHeaders || !existsSync(cur.coreHeaders)) throw new Error("offline: no synced headers — run `qinit up` online first");
          version = cur.headersVersion ?? "cached";
        } else {
          const m = await loadManifest(ref);
          version = m.version; headersAsset = m.headers; nodeAsset = m.node;
        }

        // Headers: reuse if already synced for this version, else fetch+extract.
        set("headers", "active");
        const cur0 = readCurrent();
        if (o.offline) set("headers", "ok", `reuse ${version}`);
        else if (cur0?.headersVersion === version && cur0.coreHeaders && existsSync(cur0.coreHeaders)) set("headers", "ok", `cached ${version}`);
        else {
          if (!headersAsset) throw new Error(`manifest ${version} has no headers asset`);
          const root = cacheHeaders(version);
          await extractTarGz(await fetchVerify(headersAsset), root);
          updateCurrent({ headersVersion: version, coreHeaders: root });
          set("headers", "ok", `fetched ${version}`);
        }

        // Node binary: reuse cached, else fetch (fetchNodeBin skips download if already cached).
        set("node", "active");
        let bin: string;
        if (o.offline) {
          const c = cachedNode();
          if (!c) throw new Error("offline: no cached node — run `qinit up` online first");
          bin = c; set("node", "ok", "reuse cached");
        } else { bin = (await fetchNodeBin(ref)).bin; set("node", "ok", `ready ${version}`); }

        // wasm compiler: fetch the host's wasi-sdk (clang + wasi-sysroot) so `qinit build` needs zero
        // native deps. Best-effort — WASM_CLANG/WASI_SYSROOT or a clang on PATH still work.
        set("wasi-sdk", "active");
        try {
          if (o.offline) set("wasi-sdk", "ok", haveWasiSdkCache() ? "cached" : "offline — skipped");
          else { const s = await fetchWasiSdk((rc, tt) => set("wasi-sdk", "active", tt ? `${(rc / 1e6) | 0}/${(tt / 1e6) | 0} MB` : `${(rc / 1e6) | 0} MB`)); set("wasi-sdk", "ok", s.cached ? "cached" : "fetched"); }
        } catch { set("wasi-sdk", "ok", "unavailable — set WASM_CLANG/WASI_SYSROOT"); }

        // Run: reuse a node that's already ticking (keeps deployed state); else (re)launch.
        set("run", "active", "checking");
        const st = await nodeStatus(rpcBase);
        let scratch = "", ok: boolean, tick: number;
        if (st.up && st.ticking && !o.restart) {
          ok = true; tick = st.tick;
          set("run", "ok", `reused, ticking at ${tick}`);
        } else {
          const why = !st.up ? "no node" : st.ticking ? "--restart" : "node idle";
          set("run", "active", `${why} → launching`);
          await killNode();
          const l = launchNode({ bin, dir: o.dir, mode: o["node-mode"], peers: o.peers });
          scratch = l.scratch;
          const w = await waitTicking(rpcBase, Number(o.wait || 90));
          ok = w.ticking; tick = w.tick;
          if (w.ticking) set("run", "ok", `launched pid ${l.pid}, ticking at ${tick}`);
          else set("run", "fail", w.exited ? "exited early — see node.log" : "not ticking — see node.log");
        }

        // Trust the run verdict above; just read contracts once (no extra tick sampling).
        const contracts = await nodeContracts(rpcBase);
        const rows: [string, string][] = [
          ["version", version], ["rpc", rpcBase], ["tick", String(tick)],
          ["contracts", contracts.length ? contracts.join(", ") : "(none)"],
        ];
        if (scratch) rows.push(["scratch", scratch]);
        setDone({ title: ok ? "up ✓" : "up — node not ticking", color: ok ? theme.ok : theme.warn, rows });
      } catch (e: any) {
        setSteps((ps) => ps.map((p) => (p.state === "active" ? { ...p, state: "fail" } : p)));
        setDone({ title: "up failed", color: theme.err, rows: [["error", String(e?.message ?? e)]] });
      }
    })();
  }, []);
  useEffect(() => { if (done) { process.exitCode = done.color === theme.err ? 1 : 0; const t = setTimeout(() => exit(), 50); return () => clearTimeout(t); } }, [done]);

  return (
    <Box flexDirection="column">
      <Header cmd="up" />
      {steps.map((p) => <Step key={p.key} state={p.state} label={p.label} detail={p.detail} />)}
      {done && <Box marginTop={1}><Panel title={done.title} color={done.color}><KV rows={done.rows} /></Panel></Box>}
    </Box>
  );
}
