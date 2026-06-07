import { useEffect, useState } from "react";
import { Box, useApp } from "ink";
import { resolve } from "node:path";
import { Header, Spinner, Panel, KV, Status, theme } from "../ui";
import { readCurrent } from "@qinit/core";
import { killNode, nodeAlive, fetchNodeBin, ensureNode, launchNode, waitTicking, nodeStatus } from "../node-ops";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) { const a = args[i]; if (a.startsWith("--")) o[a.slice(2)] = args[++i] ?? ""; }
  return o;
}
const dlLabel = (recv: number, total: number) =>
  total ? `downloading node ${(recv / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB` : `downloading node ${(recv / 1e6).toFixed(0)} MB`;

type Line = { t: string; ok?: boolean };
type State = { phase: "run"; spin: string } | { phase: "done"; title: string; color: string; lines: Line[]; rows?: [string, string][] };

export function Node({ args }: { args: string[] }) {
  const { exit } = useApp();
  const sub = args[0] ?? "status";
  const o = parse(args);
  const rpcBase = o.rpc || "http://127.0.0.1:41841";
  const [s, setS] = useState<State>({ phase: "run", spin: sub });

  useEffect(() => {
    (async () => {
      const L: Line[] = [];
      const add = (t: string, ok?: boolean) => L.push({ t, ok });
      try {
        if (sub === "run") {
          // Prefer the latest release; --bin only overrides for a local build; cached node is the
          // offline fallback (don't run a stale pinned version when a newer release exists).
          let bin = o.bin ? resolve(o.bin) : "";
          if (!bin) { const r = await ensureNode(o.ref || "latest", (rc, tt) => setS({ phase: "run", spin: dlLabel(rc, tt) })); bin = r.bin; if (r.stale) add(`offline — cached ${r.version}`, true); }
          const waitS = Number(o.wait || 60);
          setS({ phase: "run", spin: "stopping any running node" });
          await killNode();
          add("old node stopped", true);
          const { pid, scratch, log } = launchNode({ bin, dir: o.dir, mode: o["node-mode"], peers: o.peers, keep: o.keep !== undefined });
          add(`launched pid ${pid}`, true);
          setS({ phase: "run", spin: `waiting for ticking (≤${waitS}s)` });
          const w = await waitTicking(rpcBase, waitS);
          add(w.ticking ? `ticking at ${w.tick}` : w.exited ? "node exited early — see log" : "not ticking yet — see log", w.ticking);
          setS({ phase: "done", title: w.ticking ? "node up ✓" : "node not ticking", color: w.ticking ? theme.ok : theme.warn,
            lines: L, rows: [["bin", bin], ["scratch", scratch], ["rpc", rpcBase], ["log", log]] });
          return;
        }

        if (sub === "status") {
          const st = await nodeStatus(rpcBase);
          if (!st.up) { add("rpc: down (node not reachable)", false); setS({ phase: "done", title: "node down", color: theme.err, lines: L }); return; }
          add(st.ticking ? "rpc: up, ticking" : "rpc: up, not yet ticking", st.ticking);
          const rows: [string, string][] = [["tick", String(st.tick)], ["epoch", String(st.epoch)], ["dyn slots", `${st.armed} armed / ${st.slotCount}`]];
          if (st.contracts.length) rows.push(["contracts", st.contracts.join(", ")]);
          const cur = readCurrent();
          if (cur?.headersVersion || cur?.nodeVersion) rows.push(["synced", `headers ${cur?.headersVersion ?? "—"} · node ${cur?.nodeVersion ?? "—"}`]);
          if (cur?.headersVersion && cur?.nodeVersion && cur.headersVersion !== cur.nodeVersion) add("⚠ headers/node version drift — run `qinit up`", false);
          setS({ phase: "done", title: st.ticking ? "node up ✓" : "node up (idle)", color: st.ticking ? theme.ok : theme.warn, lines: L, rows });
          return;
        }

        if (sub === "stop") {
          if (!nodeAlive()) { add("no node running", true); setS({ phase: "done", title: "stopped", color: theme.info, lines: L }); return; }
          await killNode();
          const dead = !nodeAlive();
          add(dead ? "node stopped" : "node still alive (pkill failed)", dead);
          setS({ phase: "done", title: dead ? "stopped ✓" : "stop failed", color: dead ? theme.ok : theme.err, lines: L });
          return;
        }

        if (sub === "get") {
          setS({ phase: "run", spin: `fetching node ${o.ref || "latest"}` });
          const { bin, version } = await fetchNodeBin(o.ref || "latest", (rc, tt) => setS({ phase: "run", spin: dlLabel(rc, tt) }));
          add(`node ${version} cached`, true);
          setS({ phase: "done", title: "node fetched ✓", color: theme.ok, lines: L, rows: [["version", version], ["bin", bin]] });
          return;
        }

        add(`unknown: node ${sub} (run|status|stop|get)`, false);
        setS({ phase: "done", title: "node", color: theme.warn, lines: L });
      } catch (e: any) {
        add("ERROR: " + String(e?.message ?? e), false);
        setS({ phase: "done", title: "node " + sub + " failed", color: theme.err, lines: L });
      }
    })();
  }, []);
  useEffect(() => { if (s.phase === "done") { process.exitCode = s.lines.some((l) => l.ok === false) ? 1 : 0; exit(); } }, [s, exit]);

  return (
    <Box flexDirection="column">
      <Header cmd={`node ${sub}`} />
      {s.phase === "run" && <Spinner label={s.spin} />}
      {s.phase === "done" && (
        <Panel title={s.title} color={s.color}>
          {s.lines.map((l, i) => <Status key={i} ok={l.ok} label={l.t} pad={0} />)}
          {s.rows && s.rows.length > 0 && <Box marginTop={1}><KV rows={s.rows} /></Box>}
        </Panel>
      )}
    </Box>
  );
}
