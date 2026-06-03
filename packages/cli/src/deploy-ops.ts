// Build + chunk-upload + deploy a contract to a ticking node. Shared by `qinit deploy` and `qinit dev`.
// Emits stable log strings (deploy.tsx's deriveSteps parses them).
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { buildSignedTx, broadcastTx, broadcastTxs, LiteRpc, k12Hex } from "@qinit/core";
import { encodeUploadBegin, encodeUploadChunk, encodeDeploy, chunkSo, newSessionId, LITE_TX, resolveSlot } from "@qinit/proto";

export interface DeployOpts {
  contractPath: string; name: string; core: string; rpcBase: string;
  seed?: string; dynCallees?: Record<string, { header: string; index: number }>;
  slotOverride?: number; outDir?: string;
}
export interface DeployResult { ok: boolean; slot?: number; reused?: boolean; hash?: string; txId?: string; error?: string; }

export async function deployContract(o: DeployOpts, log: (s: string) => void): Promise<DeployResult> {
  const rpc = new LiteRpc(o.rpcBase);

  // Wait until the node is TICKING (advancing) — broadcasting during early boot crashes it.
  log("waiting for node to tick…");
  let t0 = -1, cur = 0;
  for (let i = 0; i < 90; i++) {
    try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? ti.currentTick ?? 0; if (t0 < 0) t0 = cur; if (cur > t0 + 3) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (cur <= t0 + 3) { log("✗ node not ticking"); return { ok: false, error: "node not ticking" }; }
  log(`node ticking at ${cur}`);

  // No seed: ask the node for a funded testnet seed; else a*55.
  let seed = o.seed;
  if (!seed) { const f = await rpc.fundedSeed(); if (f) { seed = f; log("using node funded seed"); } }
  seed = seed ?? "a".repeat(55);

  const { slot, reused } = await resolveSlot(rpc, o.name, o.slotOverride);
  log(`${o.name} → slot ${slot} ${reused ? "(reuse/upgrade)" : "(new)"}`);

  log("building .so …");
  const b = await buildContract({ contractPath: o.contractPath, name: o.name, slot, corePath: o.core, outDir: o.outDir ?? resolve("dist/contracts"), dynCallees: o.dynCallees });
  if (!b.ok) { log("✗ build failed"); log((b.stderr ?? "").split("\n").slice(0, 12).join("\n")); return { ok: false, slot, error: "build failed" }; }
  const so = readFileSync(b.so!);
  const hash = b.hash ?? (await k12Hex(new Uint8Array(so)));
  log(`built ${so.length}B  k12 ${hash.slice(0, 16)}…`);

  // Re-read tick after the (multi-second) build so offsets aren't stale.
  try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? cur; } catch {}
  const uploadTick = cur + 8, deployTick = cur + 9;
  log(`upload @tick ${uploadTick}, deploy @tick ${deployTick}`);

  const session = newSessionId();
  const chunks = chunkSo(new Uint8Array(so));
  const mk = async (it: number, p: Uint8Array, t: number) => (await buildSignedTx(seed!, { tick: t, inputType: it, payload: p })).bytes;

  const uploads: Uint8Array[] = [];
  uploads.push(await mk(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId: session, totalSize: so.length, chunkCount: chunks.length, finalHashHex: hash }), uploadTick));
  for (let i = 0; i < chunks.length; i++) uploads.push(await mk(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq: i, bytes: chunks[i] }), uploadTick));
  const ur = await broadcastTxs(uploads, o.rpcBase);
  const okc = ur.filter((r) => r.ok).length;
  log(`uploads broadcast: ${okc}/${ur.length} ok`);
  const bad = ur.find((r) => !r.ok);
  if (bad) log(`  first failure: code=${bad.code} ${bad.message ?? ""}`);

  const dr = await broadcastTx(await mk(LITE_TX.DEPLOY, encodeDeploy({ sessionId: session, targetSlot: slot, finalHashHex: hash, name: o.name }), deployTick), o.rpcBase);
  log(`Deploy broadcast: ${dr.ok ? "ok " + (dr.transactionId ?? "").slice(0, 16) : "FAIL code=" + dr.code + " " + (dr.message ?? "")}`);

  // Merge the build IDL into ./qinit.idl.json keyed by slot.
  if (dr.ok && b.idl) {
    try {
      const p = "qinit.idl.json";
      const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
      all[String(slot)] = { name: b.idl.name, functions: b.idl.functions, procedures: b.idl.procedures };
      writeFileSync(p, JSON.stringify(all, null, 2));
      log(`idl -> qinit.idl.json [${slot}] = ${b.idl.name} (${Object.keys(b.idl.functions).length} fn / ${Object.keys(b.idl.procedures).length} proc)`);
    } catch (e: any) { log("idl merge skipped: " + String(e?.message ?? e)); }
  }

  log("polling node …");
  let last = cur;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const t: any = await rpc.tickInfo(); last = t.tick ?? t.currentTick ?? last; if (last > deployTick + 3) break; } catch {}
  }
  log(last > deployTick ? `node ticking at ${last} (past deploy) — check node log for LITEDYN messages` : `✗ node tick ${last} did not pass ${deployTick}`);
  return { ok: dr.ok, slot, reused, hash, txId: dr.transactionId };
}
