import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, fetchVerify, extractTarGz, cacheHeaders, readCurrent, updateCurrent, fetchWasiSdk, haveWasiSdkCache } from "@qinit/core";
import { fetchNodeBin, cachedNode, nodeStatus, nodeContracts, killNode, launchNode, launchVirtualNode, waitTicking } from "../node-ops";
import { savedMode, loadConfig } from "../config";
import { Header, Step, type StepState, Panel, KV, theme } from "../ui";
import { parseArgs, output } from "../args";

// qinit node run [--ref <tag>] [--restart] [--offline] [--bin <path>] [--tick-ms <n>] [--keep] [--rpc] [--wait]
// One command bring-up: sync headers + fetch the wasm compiler + get the node + run it. Reuses a node that's
// already ticking (preserves deployed contracts); restarts only a stale/idle node or on --restart. Skips
// re-fetch when cached. With `qinit mode virtualnode` the in-process engine replaces the node binary.
// Shared parser — `restart`/`offline`/`keep` are booleans (never consume the next token); everything else `--k v`.
function parse(args: string[]): Record<string, string> {
  const a = parseArgs(args, { booleans: ["restart", "offline", "keep"] });
  const o: Record<string, string> = { ...a.flags };
  for (const b of ["restart", "offline", "keep"]) if (a.has(b)) o[b] = "1";
  return o;
}

type Phase = { key: string; label: string; state: StepState; detail?: string };

export function NodeRun({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const rpcBase = o.rpc || "http://127.0.0.1:41841";
  const ref = o.ref || "latest";
  const virtual = savedMode() === "virtualnode";   // `qinit mode` chooses the node backend
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
          if (!cur?.coreHeaders || !existsSync(cur.coreHeaders)) throw new Error("offline: no synced headers — run `qinit node run` online first");
          version = cur.headersVersion ?? "cached";
        } else {
          try {
            const m = await loadManifest(ref);
            version = m.version; headersAsset = m.headers; nodeAsset = m.node;
          } catch (e) {
            // The virtual backend needs no node release; if the manifest is unreachable, run on cached headers.
            if (!virtual) throw e;
            const cur = readCurrent();
            if (!cur?.coreHeaders || !existsSync(cur.coreHeaders)) throw new Error("no cached headers — run `qinit node run` online once to sync headers + wasi-sdk");
            version = cur.headersVersion ?? "cached";
          }
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

        // Node binary: not needed for the virtual backend (the in-process engine replaces it); otherwise
        // reuse cached, else fetch (fetchNodeBin skips download if already cached).
        set("node", "active");
        let bin = "";
        if (virtual) {
          set("node", "ok", "virtual engine — no binary");
        } else if (o.bin) {
          bin = resolve(o.bin);
          if (!existsSync(bin)) throw new Error(`--bin not found: ${bin}`);
          set("node", "ok", `local ${bin}`);
        } else if (o.offline) {
          const c = cachedNode();
          if (!c) throw new Error("offline: no cached node — run `qinit node run` online first");
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
          set("run", "active", `${why} → launching${virtual ? " virtual engine" : ""}`);
          await killNode(o.dir);
          const l = virtual
            ? launchVirtualNode({ dir: o.dir, rpcBase, keep: o.keep !== undefined, tickMs: o["tick-ms"] !== undefined ? Number(o["tick-ms"]) : undefined, system: loadConfig().system })
            : launchNode({ bin, dir: o.dir, mode: o["node-mode"], peers: o.peers, keep: o.keep !== undefined });
          scratch = l.scratch;
          const w = await waitTicking(rpcBase, Number(o.wait || 90));
          ok = w.ticking; tick = w.tick;
          if (w.ticking) set("run", "ok", `launched pid ${l.pid}, ticking at ${tick}`);
          else set("run", "fail", w.exited ? "exited early — see node.log" : "not ticking — see node.log");
        }

        // Trust the run verdict above; just read contracts once (no extra tick sampling).
        const contracts = await nodeContracts(rpcBase);
        const rows: [string, string][] = [
          ["backend", virtual ? "virtualnode (in-process engine)" : "realnode"],
          ["version", version], ["rpc", rpcBase], ["tick", String(tick)],
          ["contracts", contracts.length ? contracts.join(", ") : "(none)"],
        ];
        if (scratch) rows.push(["scratch", scratch]);
        setDone({ title: ok ? "node up ✓" : "node not ticking", color: ok ? theme.ok : theme.warn, rows });
      } catch (e: any) {
        setSteps((ps) => ps.map((p) => (p.state === "active" ? { ...p, state: "fail" } : p)));
        setDone({ title: "node run failed", color: theme.err, rows: [["error", String(e?.message ?? e)]] });
      }
    })();
  }, []);
  useEffect(() => { if (done) {
    if (output.json) process.stdout.write(JSON.stringify({ ok: done.color !== theme.err, ...Object.fromEntries(done.rows) }) + "\n");
    process.exitCode = done.color === theme.err ? 1 : 0; const t = setTimeout(() => exit(), 50); return () => clearTimeout(t);
  } }, [done]);

  if (output.json) return null;
  return (
    <Box flexDirection="column">
      <Header cmd="node run" />
      {steps.map((p) => <Step key={p.key} state={p.state} label={p.label} detail={p.detail} />)}
      {done && <Box marginTop={1}><Panel title={done.title} color={done.color}><KV rows={done.rows} /></Panel></Box>}
    </Box>
  );
}
