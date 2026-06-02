import { useEffect, useState } from "react";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContract } from "@qinit/build";
import { buildSignedTx, broadcastTx, broadcastTxs, LiteRpc, k12Hex } from "@qinit/core";
import {
  encodeUploadBegin, encodeUploadChunk, encodeDeploy, chunkSo, newSessionId, LITE_TX, resolveSlot,
} from "@qinit/proto";
import { loadConfig } from "../config";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i] ?? "";
  return o;
}

export function Deploy({ args }: { args: string[] }) {
  const o = parse(args);
  const { exit } = useApp();
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const add = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => {
    (async () => {
      try {
        const cfg = loadConfig();
        const core = o.core ?? cfg.core ?? process.env.QINIT_CORE ?? "/home/kali/Projects/qubic-core-lite";
        const name = o.name ?? cfg.name ?? "Counter";
        const seed = o.seed ?? "a".repeat(55);
        const rpcBase = o.rpc ?? cfg.rpc ?? "http://127.0.0.1:41841";
        const rpc = new LiteRpc(rpcBase);

        // Inter-contract: repeatable --callee Name=/abs/header.h@slot (dynamic callees, deployed earlier).
        const dynCallees: Record<string, { header: string; index: number }> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== "--callee") continue;
          const m = (args[i + 1] ?? "").match(/^(\w+)=(.+)@(\d+)$/);
          if (m) dynCallees[m[1]] = { header: resolve(m[2]), index: Number(m[3]) };
        }

        // Wait for the node to be TICKING (advancing), not just RPC-up — broadcasting during
        // early boot crashes the node (network/peer state not ready). See feedback memory.
        add("waiting for node to tick…");
        let t0 = -1, cur = 0;
        for (let i = 0; i < 90; i++) {
          try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? ti.currentTick ?? 0; if (t0 < 0) t0 = cur; if (cur > t0 + 3) break; } catch {}
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (cur <= t0 + 3) { add("✗ node not ticking"); setDone(true); return; }
        add(`node ticking at ${cur}`);

        // Resolve the slot by name (user never picks one): reuse if already deployed, else first free.
        const ov = (o.slot ?? cfg.slot) !== undefined && (o.slot ?? cfg.slot) !== "" ? Number(o.slot ?? cfg.slot) : undefined;
        const { slot, reused } = await resolveSlot(rpc, name, ov);
        add(`${name} → slot ${slot} ${reused ? "(reuse/upgrade)" : "(new)"}`);

        add("building .so …");
        const b = await buildContract({
          contractPath: resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h"),
          name, slot, corePath: core, outDir: resolve("dist/contracts"), dynCallees,
        });
        if (!b.ok) { add("✗ build failed"); add((b.stderr ?? "").split("\n").slice(0, 12).join("\n")); setDone(true); return; }
        const so = readFileSync(b.so!);
        const hash = b.hash ?? (await k12Hex(new Uint8Array(so)));
        add(`built ${so.length}B  k12 ${hash.slice(0, 16)}…`);

        // Re-read tick after the (multi-second) build so the offsets aren't stale.
        try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? cur; } catch {}
        const uploadTick = cur + 8;
        const deployTick = cur + 9;
        add(`upload @tick ${uploadTick}, deploy @tick ${deployTick}`);

        const session = newSessionId();
        const chunks = chunkSo(new Uint8Array(so));
        const mk = async (inputType: number, payload: Uint8Array, t: number) =>
          (await buildSignedTx(seed, { tick: t, inputType, payload })).bytes;

        const uploads: Uint8Array[] = [];
        uploads.push(await mk(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId: session, totalSize: so.length, chunkCount: chunks.length, finalHashHex: hash }), uploadTick));
        for (let i = 0; i < chunks.length; i++)
          uploads.push(await mk(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq: i, bytes: chunks[i] }), uploadTick));
        const ur = await broadcastTxs(uploads, rpcBase);
        const okc = ur.filter((r) => r.ok).length;
        add(`uploads broadcast: ${okc}/${ur.length} ok`);
        const bad = ur.find((r) => !r.ok);
        if (bad) add(`  first failure: code=${bad.code} ${bad.message ?? ""}`);

        const dr = await broadcastTx(await mk(LITE_TX.DEPLOY, encodeDeploy({ sessionId: session, targetSlot: slot, finalHashHex: hash, name }), deployTick), rpcBase);
        add(`Deploy broadcast: ${dr.ok ? "ok " + (dr.transactionId ?? "").slice(0, 16) : "FAIL code=" + dr.code + " " + (dr.message ?? "")}`);

        // Merge the build IDL into ./qinit.idl.json keyed by slot -> interactive /call shows names.
        if (dr.ok && b.idl) {
          try {
            const p = "qinit.idl.json";
            const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
            all[String(slot)] = { name: b.idl.name, functions: b.idl.functions, procedures: b.idl.procedures };
            writeFileSync(p, JSON.stringify(all, null, 2));
            add(`idl -> qinit.idl.json [${slot}] = ${b.idl.name} (${Object.keys(b.idl.functions).length} fn / ${Object.keys(b.idl.procedures).length} proc)`);
          } catch (e: any) { add("idl merge skipped: " + String(e?.message ?? e)); }
        }

        add("polling node …");
        let last = cur;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try { const t: any = await rpc.tickInfo(); last = t.tick ?? t.currentTick ?? last; if (last > deployTick + 3) break; } catch {}
        }
        add(last > deployTick ? `node ticking at ${last} (past deploy) — check node log for LITEDYN messages` : `✗ node tick ${last} did not pass ${deployTick}`);
        setDone(true);
      } catch (e: any) {
        add("ERROR: " + String(e?.stack ?? e?.message ?? e).slice(0, 300));
        setDone(true);
      }
    })();
  }, []);
  useEffect(() => { if (done) exit(); }, [done]);

  return (
    <Box flexDirection="column">
      {log.map((l, i) => <Text key={i}>{l}</Text>)}
      {!done && <Text dimColor>…</Text>}
    </Box>
  );
}
