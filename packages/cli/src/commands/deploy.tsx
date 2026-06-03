import { useEffect, useState } from "react";
import { resolve, basename } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Box, Text, useApp } from "ink";
import { buildContract } from "@qinit/build";
import { buildSignedTx, broadcastTx, broadcastTxs, LiteRpc, k12Hex } from "@qinit/core";
import {
  encodeUploadBegin, encodeUploadChunk, encodeDeploy, chunkSo, newSessionId, LITE_TX, resolveSlot,
} from "@qinit/proto";
import { loadConfig, resolveCore } from "../config";
import { Header, Spinner, Step, type StepState, theme } from "../ui";

function parse(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) o[args[i].slice(2)] = args[++i] ?? "";
  return o;
}

// Derive a 6-phase pipeline from the append-only log (log strings are stable; unknown -> pending).
type Phase = { key: string; label: string; state: StepState; detail?: string };
function deriveSteps(log: string[]): Phase[] {
  const P: Phase[] = [
    { key: "tick", label: "node ticking", state: "pending" },
    { key: "slot", label: "resolve slot", state: "pending" },
    { key: "build", label: "build .so", state: "pending" },
    { key: "upload", label: "upload chunks", state: "pending" },
    { key: "deploy", label: "deploy", state: "pending" },
    { key: "confirm", label: "confirm", state: "pending" },
  ];
  const set = (k: string, s: StepState, d?: string) => { const p = P.find((x) => x.key === k)!; p.state = s; if (d !== undefined) p.detail = d; };
  for (const l of log) {
    if (l.startsWith("waiting for node")) set("tick", "active");
    else if (l.includes("not ticking")) set("tick", "fail");
    else if (/^node ticking at \d+$/.test(l)) set("tick", "ok", l.replace("node ticking at ", "tick "));
    if (l.includes("→ slot")) set("slot", "ok", l.slice(l.indexOf("→") + 1).trim());
    if (l.startsWith("building .so")) set("build", "active");
    else if (l.startsWith("built ")) set("build", "ok", l.slice(6));
    else if (l.includes("build failed")) set("build", "fail");
    if (l.startsWith("uploads broadcast:")) { const m = l.match(/(\d+)\/(\d+) ok/); set("upload", m && m[1] === m[2] ? "ok" : "fail", m ? `${m[1]}/${m[2]}` : undefined); }
    if (l.startsWith("Deploy broadcast:")) set("deploy", l.includes("FAIL") ? "fail" : "ok", l.replace("Deploy broadcast: ", ""));
    if (l.startsWith("polling node")) set("confirm", "active");
    else if (l.includes("(past deploy)")) set("confirm", "ok");
    else if (l.includes("did not pass")) set("confirm", "fail");
    if (l.startsWith("ERROR")) { const a = P.find((x) => x.state === "active"); if (a) a.state = "fail"; }
  }
  return P;
}
function isPhaseLine(l: string): boolean {
  return /^waiting for node|not ticking|^node ticking at \d+$|→ slot|^building \.so|^built |build failed|^uploads broadcast:|^Deploy broadcast:|^polling node|\(past deploy\)|did not pass|^upload @tick/.test(l);
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
        const core = resolveCore(o.core, cfg.core);
        const contractPath = resolve(o.contract ?? cfg.contract ?? "fixtures/Counter.h");
        // Name derived from the contract filename (Counter.h -> Counter); --name / cfg.name override.
        const name = o.name ?? cfg.name ?? basename(contractPath).replace(/\.[^.]+$/, "");
        let seed: string = o.seed ?? "a".repeat(55); // overridden with the node's funded seed below if no --seed
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

        // No --seed: ask the node for a funded testnet seed (testnet-only RPC); else keep the a*55 default.
        if (!o.seed) { const f = await rpc.fundedSeed(); if (f) { seed = f; add("using node funded seed"); } }

        // Resolve the slot by name (user never picks one): reuse if already deployed, else first free.
        const ov = (o.slot ?? cfg.slot) !== undefined && (o.slot ?? cfg.slot) !== "" ? Number(o.slot ?? cfg.slot) : undefined;
        const { slot, reused } = await resolveSlot(rpc, name, ov);
        add(`${name} → slot ${slot} ${reused ? "(reuse/upgrade)" : "(new)"}`);

        add("building .so …");
        const b = await buildContract({
          contractPath,
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

  const steps = deriveSteps(log);
  const extras = log.filter((l) => !isPhaseLine(l));
  return (
    <Box flexDirection="column">
      <Header cmd="deploy" />
      <Box flexDirection="column">
        {steps.map((p) => <Step key={p.key} state={p.state} label={p.label} detail={p.detail} />)}
      </Box>
      {extras.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {extras.map((l, i) => (
            <Text key={i} color={l.startsWith("ERROR") ? theme.err : undefined} dimColor={!l.startsWith("ERROR")}>{l}</Text>
          ))}
        </Box>
      )}
      {!done && <Box marginTop={1}><Spinner label="working" /></Box>}
    </Box>
  );
}
