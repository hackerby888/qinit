// Build + chunk-upload + deploy a contract to a ticking node. Shared by `qinit deploy` and `qinit dev`.
// Emits STRUCTURED progress events (step state + live detail + pct) so the UI can show a rich pipeline.
import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildContract, type ContractIdl } from "@qinit/build";
import { buildSignedTx, broadcastTx, LiteRpc, k12Hex, readCurrent, autoUpdateVerifyTool } from "@qinit/core";
import { encodeUploadBegin, encodeUploadChunk, encodeDeploy, chunkSo, newSessionId, LITE_TX, resolveSlot } from "@qinit/proto";

export type StepKey = "tick" | "slot" | "build" | "upload" | "deploy" | "confirm";
export type Ev =
  | { step: StepKey; state: "active" | "ok" | "fail"; detail?: string; pct?: number }
  | { note: string };

export const STEPS: { key: StepKey; label: string }[] = [
  { key: "tick", label: "node ticking" },
  { key: "slot", label: "resolve slot" },
  { key: "build", label: "build .so" },
  { key: "upload", label: "upload" },
  { key: "deploy", label: "deploy" },
  { key: "confirm", label: "confirm" },
];

export interface DeployOpts {
  contractPath: string; name: string; core: string; rpcBase: string;
  seed?: string; dynCallees?: Record<string, { header: string; index: number }>;
  slotOverride?: number; outDir?: string;
}
export interface DeployResult {
  ok: boolean; slot?: number; reused?: boolean; hash?: string; txId?: string;
  armed?: boolean; reason?: string; idl?: ContractIdl; error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deployContract(o: DeployOpts, emit: (e: Ev) => void): Promise<DeployResult> {
  const rpc = new LiteRpc(o.rpcBase);

  const pin = readCurrent();
  if (pin?.headersVersion && pin?.nodeVersion && pin.headersVersion !== pin.nodeVersion)
    emit({ note: `⚠ version drift: headers ${pin.headersVersion} ≠ node ${pin.nodeVersion} — run 'qinit up'` });

  // Daily-cached, best-effort verify-tool auto-update (offline = skip).
  const vu = await autoUpdateVerifyTool();
  if (vu.action === "updated" || vu.action === "installed") emit({ note: `↻ contractverify ${vu.action} → ${vu.version}` });

  // tick — wait until advancing (broadcasting during boot crashes the node)
  emit({ step: "tick", state: "active", detail: "waiting for node…" });
  let t0 = -1, cur = 0;
  for (let i = 0; i < 90; i++) {
    try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? ti.currentTick ?? 0; if (t0 < 0) t0 = cur; emit({ step: "tick", state: "active", detail: `tick ${cur}` }); if (cur > t0 + 3) break; } catch {}
    await sleep(1000);
  }
  if (cur <= t0 + 3) { emit({ step: "tick", state: "fail", detail: "not ticking" }); return { ok: false, error: "node not ticking" }; }
  emit({ step: "tick", state: "ok", detail: `tick ${cur}` });

  // seed — funded one from the node if none given
  let seed = o.seed;
  if (!seed) { const f = await rpc.fundedSeed(); if (f) { seed = f; emit({ note: "using node funded seed" }); } }
  seed = seed ?? "a".repeat(55);

  // slot — resolve by name (reuse or first free)
  emit({ step: "slot", state: "active" });
  const { slot, reused } = await resolveSlot(rpc, o.name, o.slotOverride);
  emit({ step: "slot", state: "ok", detail: `slot ${slot} ${reused ? "(reuse)" : "(new)"}` });

  // build
  emit({ step: "build", state: "active", detail: "compiling…" });
  const b = await buildContract({ contractPath: o.contractPath, name: o.name, slot, corePath: o.core, outDir: o.outDir ?? resolve("dist/contracts"), dynCallees: o.dynCallees });
  if (!b.ok) {
    const why = b.verify && !b.verify.ok && b.verify.errors.length ? `protocol: ${b.verify.errors[0]}` : "compile failed";
    emit({ step: "build", state: "fail", detail: why });
    emit({ note: (b.stderr ?? "").split("\n").slice(0, 14).join("\n") });
    return { ok: false, slot, error: why };
  }
  const so = readFileSync(b.so!);
  const hash = b.hash ?? (await k12Hex(new Uint8Array(so)));
  emit({ step: "build", state: "ok", detail: `${so.length}B · k12 ${hash.slice(0, 12)}…` });

  try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? cur; } catch {}
  const uploadTick = cur + 8, deployTick = cur + 9;

  const session = newSessionId();
  const chunks = chunkSo(new Uint8Array(so));
  const mk = async (it: number, p: Uint8Array, t: number) => (await buildSignedTx(seed!, { tick: t, inputType: it, payload: p })).bytes;
  const uploads: Uint8Array[] = [];
  uploads.push(await mk(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId: session, totalSize: so.length, chunkCount: chunks.length, finalHashHex: hash }), uploadTick));
  for (let i = 0; i < chunks.length; i++) uploads.push(await mk(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq: i, bytes: chunks[i] }), uploadTick));

  // upload — live N/total progress, per-chunk retry up to 3 rounds
  const total = uploads.length;
  const done = new Set<number>();
  emit({ step: "upload", state: "active", detail: `0/${total}`, pct: 0 });
  let pend = uploads.map((bts, i) => ({ bts, i }));
  for (let attempt = 0; attempt <= 3 && pend.length; attempt++) {
    const fail: typeof pend = [];
    for (const u of pend) {
      const r = await broadcastTx(u.bts, o.rpcBase);
      if (r.ok) done.add(u.i); else fail.push(u);
      emit({ step: "upload", state: "active", detail: `${done.size}/${total}`, pct: done.size / total });
    }
    pend = fail;
    if (pend.length) { emit({ note: `retry ${attempt + 1}: ${pend.length} chunk(s)` }); await sleep(600); }
  }
  if (done.size < total) { emit({ step: "upload", state: "fail", detail: `${done.size}/${total}` }); emit({ note: `✗ ${total - done.size} upload tx(s) failed after retries` }); return { ok: false, slot, hash, error: "upload failed" }; }
  emit({ step: "upload", state: "ok", detail: `${total}/${total} chunks`, pct: 1 });

  // deploy
  emit({ step: "deploy", state: "active" });
  const dr = await broadcastTx(await mk(LITE_TX.DEPLOY, encodeDeploy({ sessionId: session, targetSlot: slot, finalHashHex: hash, name: o.name }), deployTick), o.rpcBase);
  if (!dr.ok) {
    emit({ step: "deploy", state: "fail", detail: `code ${dr.code}` });
    emit({ step: "confirm", state: "fail", detail: "nothing landed" });
    return { ok: false, slot, hash, reason: "not-broadcast", error: "deploy not broadcast" };
  }
  emit({ step: "deploy", state: "ok", detail: `tx ${(dr.transactionId ?? "").slice(0, 12)}…` });

  if (b.idl) {
    try {
      const p = "qinit.idl.json";
      const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
      all[String(slot)] = { name: b.idl.name, functions: b.idl.functions, procedures: b.idl.procedures };
      writeFileSync(p, JSON.stringify(all, null, 2));
    } catch {}
  }

  // confirm — poll dyn-registry until armed && codeHash matches; classify the failure
  emit({ step: "confirm", state: "active", detail: "polling arm…" });
  const want = hash.toLowerCase();
  let armed = false, present = false, onNode = "", last = cur;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const ti: any = await rpc.tickInfo(); last = ti.tick ?? last;
      const reg = await rpc.dynRegistry();
      const c = (reg.contracts ?? []).find((x) => x.index === slot);
      if (c) { present = !!c.armed; onNode = (c.codeHash || "").toLowerCase(); if (c.armed && onNode === want) { armed = true; break; } }
      emit({ step: "confirm", state: "active", detail: `tick ${last}` });
    } catch {}
  }
  let reason: string | undefined;
  if (armed) emit({ step: "confirm", state: "ok", detail: `armed · ${want.slice(0, 12)}…` });
  else if (!present) { reason = "empty"; emit({ step: "confirm", state: "fail", detail: "slot empty — didn't land" }); emit({ note: "upload/deploy didn't land (chunks dropped, tick missed, or seed unfunded)" }); }
  else { reason = "wrong-code"; emit({ step: "confirm", state: "fail", detail: "different code — didn't take" }); emit({ note: `on-node ${onNode.slice(0, 12)}… ≠ yours ${want.slice(0, 12)}…` }); }

  return { ok: armed, slot, reused, hash, txId: dr.transactionId, armed, reason, idl: b.idl };
}
