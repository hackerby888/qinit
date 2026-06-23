import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LiteRpc } from "@qinit/core";
import { loadConfig } from "../config";
import { systemCatalog, systemWasm } from "../system-wasm";
import { Header, Spinner, Status } from "../ui";

// qinit system               -> list the system contracts (catalog + which are live on the node + selected)
// qinit system add <name…>   -> compile (cache) + direct-deploy onto the running virtual node; save to qinit.json
// qinit system rm  <name…>   -> undeploy on the node + drop from qinit.json
// Only the user's picks are ever compiled/deployed — a real node embeds system contracts and 404s the route.
function parse(args: string[]): { sub: string; names: string[]; rpc?: string } {
  const names: string[] = [];
  let sub = "";
  let rpc: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rpc") {
      rpc = args[++i];
    } else if (!a.startsWith("--")) {
      if (!sub) {
        sub = a;
      } else {
        names.push(a);
      }
    }
  }
  return { sub, names, rpc };
}

type Line = { t: string; ok?: boolean | null };

// Persist the selection into qinit.json (kept minimal — preserves the rest of the config).
function saveSelection(system: string[]): void {
  const path = "qinit.json";
  const cfg: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  cfg.system = system;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function System({ args }: { args: string[] }) {
  const { exit } = useApp();
  const o = parse(args);
  const cfg = loadConfig();
  const rpcBase = o.rpc || cfg.rpc || "http://127.0.0.1:41841";
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState("starting");
  const [done, setDone] = useState(false);
  const add = (t: string, ok?: boolean | null) => setLines((L) => [...L, { t, ok }]);

  useEffect(() => {
    (async () => {
      try {
        const rpc = new LiteRpc(rpcBase);
        const catalog = systemCatalog(cfg.core);

        if (o.sub === "add" || o.sub === "rm") {
          if (!o.names.length) {
            add(`usage: qinit system ${o.sub} <name…>`, false);
            setDone(true);
            return;
          }
          const selected = new Set(cfg.system ?? []);
          for (const name of o.names) {
            const c = catalog.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (!c) {
              add(`unknown system contract '${name}'`, false);
              continue;
            }
            try {
              if (o.sub === "add") {
                setBusy(`compiling ${c.name}`);
                const w = await systemWasm(c.name, cfg.core);
                setBusy(`deploying ${c.name}`);
                const r = await rpc.directDeploy(w.index, w.wasm, w.name);
                if (!r) {
                  add(`${c.name}: virtualnode-only — a real node already embeds system contracts`, false);
                  continue;
                }
                selected.add(c.name);
                add(`${c.name} @ ${w.index} deployed`, true);
              } else {
                await rpc.undeploy(c.index);
                selected.delete(c.name);
                add(`${c.name} @ ${c.index} removed`, true);
              }
            } catch (e: any) {
              add(`${c.name}: ${String(e?.message ?? e)}`, false);
            }
          }
          saveSelection([...selected].sort());
          setDone(true);
          return;
        }

        // default / ls — catalog with live + selected marks.
        setBusy("reading node");
        let live = new Set<number>();
        try {
          live = new Set(((await rpc.dynRegistry()).contracts ?? []).filter((c) => c.armed).map((c) => c.index));
        } catch { /* node down -> show catalog + selection only */ }
        const selected = new Set(cfg.system ?? []);
        for (const c of catalog) {
          const state = live.has(c.index) ? "live" : selected.has(c.name) ? "selected" : "available";
          add(`${String(c.index).padStart(2)}  ${c.name.padEnd(12)} ${state}`, live.has(c.index) ? true : null);
        }
        setDone(true);
      } catch (e: any) {
        add("ERROR: " + String(e?.message ?? e), false);
        setDone(true);
      }
    })();
  }, []);
  useEffect(() => {
    if (done) {
      process.exitCode = lines.some((l) => l.ok === false) ? 1 : 0;
      const t = setTimeout(() => exit(), 30);
      return () => clearTimeout(t);
    }
  }, [done]);

  return (
    <Box flexDirection="column">
      <Header cmd="system" />
      {!done && <Spinner label={busy} />}
      {o.sub !== "add" && o.sub !== "rm" && done && lines.length > 0 && (
        <Text dimColor>{"slot  contract     state   (add: qinit system add <name…>)"}</Text>
      )}
      {lines.map((l, i) => <Status key={i} ok={l.ok} label={l.t} pad={0} />)}
    </Box>
  );
}
