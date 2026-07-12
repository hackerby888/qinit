// Build + chunk-upload + deploy a contract to a ticking node. Shared by `qinit deploy` and `qinit dev`.
// Emits STRUCTURED progress events (step state + live detail + pct) so the UI can show a rich pipeline.
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildContract, systemNames, type BuildResult, type ContractIdl } from "@qinit/build";
import { buildSignedTx, broadcastTx, LiteRpc, k12Hex, readCurrent, autoUpdateVerifyTool } from "@qinit/core";
import { encodeUploadBegin, encodeUploadChunk, encodeDeploy, chunkSo, newSessionId, LITE_TX, resolveSlot, TX_TICK_OFFSET } from "@qinit/proto";
import { savedSeed, savedCompiler, resolveCore, type Compiler } from "./config";
import { compileLocal } from "./compile-local";

export type StepKey = "tick" | "slot" | "build" | "upload" | "deploy" | "confirm";
export type Ev =
  | { step: StepKey; state: "active" | "ok" | "fail"; detail?: string; pct?: number }
  | { note: string };

export const STEPS: { key: StepKey; label: string }[] = [
  { key: "tick", label: "node ticking" },
  { key: "slot", label: "resolve slot" },
  { key: "build", label: "build wasm" },
  { key: "upload", label: "upload" },
  { key: "deploy", label: "deploy" },
  { key: "confirm", label: "confirm" },
];

// Truthful tick-wait failure: a node that never answered is UNREACHABLE, not "not ticking" — say which,
// with the actionable hint (mirrors LiteRpc's wording). Pure so it's unit-tested without a node.
export function tickFailureMessage(reached: boolean, rpcBase: string): string {
  return reached ? "node not ticking" : `node unreachable at ${rpcBase} — is it running? (qinit node run)`;
}

// Best-effort: resolve a contract's inter-contract callees from the live node registry — each deployed
// contract submits its .h source at deploy, so the node knows name -> { deployed slot, source }. Used by both
export async function resolveNodeCallees(
  rpc: Pick<LiteRpc, "dynRegistry">,
  contractSrc: string,
  dynCallees: Record<string, { header: string; index: number }> = {},
  onNote?: (msg: string) => void,
  timeoutMs?: number, // cap the registry probe so a down node fails fast (build); omit when the node is already known up (deploy)
): Promise<Record<string, { header: string; index: number }>> {
  const out: Record<string, { header: string; index: number }> = { ...dynCallees };
  try {
    const names = [...new Set([...contractSrc.matchAll(/(?:CALL|INVOKE)_OTHER_CONTRACT_\w+\s*\(\s*(\w+)/g)].map((m) => m[1]))];
    const pending = names.filter((n) => !out[n]);
    if (pending.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const probe = rpc.dynRegistry();
      const reg = timeoutMs
        ? await Promise.race([probe.finally(() => clearTimeout(timer)), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("node probe timeout")), timeoutMs); })])
        : await probe;
      for (const n of pending) {
        const c = (reg.contracts ?? []).find((x) => x.name === n && x.armed && x.source);
        if (c) {
          const tmp = join(tmpdir(), `qinit-callee-${n}.h`);
          writeFileSync(tmp, c.source!);
          out[n] = { header: tmp, index: c.index };
          onNote?.(`callee ${n} → slot ${c.index} (from node)`);
        }
      }
    }
  } catch {
    // node down / unreachable — best-effort only
  }
  return out;
}

// Classify a deploy that never armed by the ACTUAL cause: a dyn-registry that never read back (node too
// old / RPC down) is "unknown", NOT "slot empty" — the old message blamed a dropped deploy wrongly.
export function classifyConfirm(s: { present: boolean; regOk: boolean; onNode: string; want: string }): { reason: string; detail: string; note: string } {
  if (!s.regOk) return { reason: "registry-unreadable", detail: "couldn't read dyn-registry", note: "couldn't read /dyn-registry (node too old or RPC down) — deploy state unknown" };
  if (!s.present) return { reason: "empty", detail: "slot empty — didn't land", note: "upload/deploy didn't land (chunks dropped, tick missed, or seed unfunded)" };
  return { reason: "wrong-code", detail: "different code — didn't take", note: `on-node ${s.onNode.slice(0, 12)}… ≠ yours ${s.want.slice(0, 12)}…` };
}

export interface DeployOpts {
  contractPath: string; name: string; core: string; rpcBase: string;
  seed?: string; dynCallees?: Record<string, { header: string; index: number }>;
  slotOverride?: number; outDir?: string; skipVerify?: boolean;
  compiler?: Compiler; // native clang | in-process TS; omitted -> saved `qinit compiler` pick (default native)
  /** Already-compiled bytes. Deployment uploads these exact bytes and never invokes either compiler. */
  artifact?: {
    wasm: Uint8Array; hash?: string; idl?: ContractIdl;
    /** Expected WAMR registration table shape; catches an armed slot whose module failed to load. */
    registration?: { functions: number; procedures: number };
  };
  rpc?: LiteRpc;   // injectable (tests pass a mock; prod builds one from rpcBase)
}
export interface DeployResult {
  ok: boolean; slot?: number; reused?: boolean; hash?: string; txId?: string;
  armed?: boolean; constructed?: boolean; reason?: string; idl?: ContractIdl; error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deployContract(o: DeployOpts, emit: (e: Ev) => void): Promise<DeployResult> {
  const rpc = o.rpc ?? new LiteRpc(o.rpcBase);

  // refuse a name that collides with a built-in system contract (QX, QEARN, …) — keeps name resolution unambiguous.
  try {
    if (systemNames(resolveCore(o.core)).has(o.name.toLowerCase())) {
      emit({ step: "build", state: "fail", detail: `'${o.name}' is a system contract name` });
      return { ok: false, error: `'${o.name}' is a reserved system contract name — pick another` };
    }
  } catch { /* no core snapshot resolvable -> build would fail later anyway; skip the guard */ }

  const pin = readCurrent();
  if (pin?.headersVersion && pin?.nodeVersion && pin.headersVersion !== pin.nodeVersion)
    emit({ note: `⚠ version drift: headers ${pin.headersVersion} ≠ node ${pin.nodeVersion} — run 'qinit node run'` });

  // Daily-cached, best-effort verify-tool auto-update (offline = skip).
  const vu = await autoUpdateVerifyTool();
  if (vu.action === "updated" || vu.action === "installed") emit({ note: `↻ contractverify ${vu.action} → ${vu.version}` });

  // tick — wait until advancing (broadcasting during boot crashes the node). 300s: a cold node can
  // stall a few minutes in its first ticks (initial-epoch work; seen on the Windows port) before
  emit({ step: "tick", state: "active", detail: "waiting for node…" });
  let t0 = -1, cur = 0, reached = false, miss = 0;
  for (let i = 0; i < 300; i++) {
    try {
      const ti: any = await rpc.tickInfo(); reached = true; miss = 0;
      cur = ti.tick ?? ti.currentTick ?? 0; if (t0 < 0) t0 = cur;
      emit({ step: "tick", state: "active", detail: `tick ${cur}` });
      if (cur > t0 + 3) break;
    } catch { if (!reached && ++miss >= 15) break; }   // fail fast: never answered -> unreachable, not slow
    await sleep(1000);
  }
  if (!reached || cur <= t0 + 3) {
    emit({ step: "tick", state: "fail", detail: reached ? "not ticking" : "unreachable" });
    return { ok: false, error: tickFailureMessage(reached, o.rpcBase) };
  }
  emit({ step: "tick", state: "ok", detail: `tick ${cur}` });

  // seed precedence: --seed > saved pick (`qinit seed`) > node funded seed > dev default
  let seed = o.seed;
  if (!seed) { const sv = savedSeed(); if (sv) { seed = sv; emit({ note: "using saved seed (qinit seed)" }); } }
  if (!seed) { const f = await rpc.fundedSeed(); if (f) { seed = f; emit({ note: "using node funded seed" }); } }
  seed = seed ?? "a".repeat(55);

  // slot — resolve by name (reuse or first free)
  emit({ step: "slot", state: "active" });
  const { slot, reused } = await resolveSlot(rpc, o.name, o.slotOverride);
  emit({ step: "slot", state: "ok", detail: `slot ${slot} ${reused ? "(reuse)" : "(new)"}` });

  // inter-contract callees: for each CALL/INVOKE_OTHER_CONTRACT(<Name>) not given via --callee, resolve it from
  // the node registry (name -> slot + .h source, submitted at the callee's own deploy) so no --callee is needed.
  const dynCallees = await resolveNodeCallees(rpc, readFileSync(o.contractPath, "utf8"), o.dynCallees ?? {}, (note) => emit({ note }));

  // build — native clang or the in-process TS compiler, per `qinit compiler` (or an explicit override). The
  // local path skips the protocol-rule gate (the TS compiler surfaces its own diagnostics) and produces the
  const compiler: Compiler = o.compiler ?? savedCompiler() ?? "native";
  const outDir = o.outDir ?? resolve("dist/contracts");
  if (o.artifact) emit({ note: "compiler: prebuilt artifact (exact bytes)" });
  else if (compiler === "local") emit({ note: "compiler: local TS (qinit compiler local)" });
  emit({ step: "build", state: "active", detail: o.artifact ? "validating prebuilt bytes…" : compiler === "local" ? "compiling (local TS)…" : "compiling…" });
  const b: any = o.artifact
    ? { ok: o.artifact.wasm.byteLength > 0, idl: o.artifact.idl }
    : compiler === "local"
      ? await compileLocal({ contractPath: o.contractPath, name: o.name, slot, core: o.core, outDir, dynCallees })
      : await buildContract({ contractPath: o.contractPath, name: o.name, slot, corePath: o.core, outDir, dynCallees, skipVerify: o.skipVerify });
  if (!b.ok) {
    const vr = (b as BuildResult).verify; // only the native path runs the protocol gate; local reports via stderr
    const why = vr && !vr.ok && vr.errors.length ? `protocol: ${vr.errors[0]}` : "compile failed";
    emit({ step: "build", state: "fail", detail: why });
    emit({ note: (b.stderr ?? "").split("\n").slice(0, 14).join("\n") });
    return { ok: false, slot, error: why };
  }
  const so = o.artifact ? Buffer.from(o.artifact.wasm) : readFileSync(b.so!);
  const hash = o.artifact?.hash ?? b.hash ?? (await k12Hex(new Uint8Array(so)));
  emit({ step: "build", state: "ok", detail: `${so.length}B · k12 ${hash.slice(0, 12)}…` });
  if (b.idlError) emit({ note: "⚠ IDL parse failed — no typed client/state names: " + b.idlError });

  // Single-authority virtual node: no peer network or quorum to satisfy, so skip the chunk-upload + multi-tick
  // confirm and drop the wasm straight into the slot. The route 404s on a real node (returns null) -> the
  const direct = await rpc.directDeploy(slot, new Uint8Array(so), o.name).catch(() => null);
  if (direct) {
    emit({ step: "upload", state: "ok", detail: "direct (virtualnode)" });
    emit({ step: "deploy", state: "ok", detail: `slot ${slot}` });
    try { await rpc.putContractSource(slot, readFileSync(o.contractPath, "utf8")); } catch { /* best-effort */ }
    emit({ step: "confirm", state: "ok", detail: `ready · ${hash.slice(0, 12)}…` });
    return { ok: true, slot, reused, hash, armed: true, constructed: true, idl: b.idl };
  }

  try { const ti: any = await rpc.tickInfo(); cur = ti.tick ?? cur; } catch {}
  const curTick = async () => { try { const ti: any = await rpc.tickInfo(); return (ti.tick ?? ti.currentTick ?? cur) as number; } catch { return cur; } };
  // tries is a per-second poll budget; early-exits on reach, so a high cap only matters for slow nodes
  // (e.g. a RAM-constrained CI box ticking ~8s/tick, or the Windows port's multi-minute tick stalls)
  const waitTickReach = async (target: number, tries = 300) => { let t = cur; for (let i = 0; i < tries; i++) { t = await curTick(); if (t >= target) break; await sleep(1000); } return t; };

  // Fail-fast on a pathologically slow chain (e.g. the free windows-latest CI runner, whose ~190x-slower
  // loopback drags ticks to ~50s). The upload + arm need dozens of ticks, so without this the per-step 300s
  { const ps = Date.now(); const base = cur; let adv = 0;
    while (Date.now() - ps < 30000) { await sleep(2000); adv = (await curTick()) - base; if (adv >= 3) break; }
    if (adv < 2) {
      const spt = adv > 0 ? Math.round((Date.now() - ps) / 1000 / adv) : Infinity;
      const r = spt === Infinity ? ">30" : String(spt);
      emit({ step: "upload", state: "fail", detail: `chain too slow (~${r}s/tick)` });
      return { ok: false, slot, hash, error: `node ticking far too slowly (~${r}s/tick) to deploy within budget — aborting before upload (under-provisioned runner?)` };
    } }
  cur = await curTick();                              // refresh: the probe advanced the chain
  const uploadTick = cur + TX_TICK_OFFSET;

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
  emit({ step: "upload", state: "active", detail: `${total}/${total} broadcast · confirming…`, pct: 1 });

  // assemble — broadcast-OK ≠ landed in a tick (a chunk tx can be accepted then dropped from the
  // tick). Confirm the node reassembled the full .so via dyn-upload before DEPLOY, else DEPLOY no-ops
  let assembled = false;
  await waitTickReach(uploadTick + 1);              // let the chunk tick be processed first
  for (let round = 0; round < 4 && !assembled; round++) {
    let u: Awaited<ReturnType<typeof rpc.dynUpload>> | null = null;
    try { u = await rpc.dynUpload(); } catch {}
    if (u && u.active && u.sessionId === String(session)) {
      if (u.complete) { assembled = true; break; }
      const miss = (u.missing ?? []).filter((s) => s < chunks.length);
      if (!miss.length) { await waitTickReach((await curTick()) + 1); continue; }  // count lagging — recheck
      const t = (await curTick()) + TX_TICK_OFFSET;
      for (const seq of miss) await broadcastTx(await mk(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq, bytes: chunks[seq] }), t), o.rpcBase);
      emit({ note: `assembly: resent ${miss.length} missing chunk(s) [round ${round + 1}]` });
      await waitTickReach(t + 1);
    } else {
      // session not active on-node (BEGIN dropped/superseded) — resend BEGIN + all chunks at a fresh tick.
      const t = (await curTick()) + TX_TICK_OFFSET;
      await broadcastTx(await mk(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId: session, totalSize: so.length, chunkCount: chunks.length, finalHashHex: hash }), t), o.rpcBase);
      for (let i = 0; i < chunks.length; i++) await broadcastTx(await mk(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq: i, bytes: chunks[i] }), t), o.rpcBase);
      emit({ note: `assembly: re-sent BEGIN + ${chunks.length} chunk(s) [round ${round + 1}]` });
      await waitTickReach(t + 1);
    }
  }
  emit({ step: "upload", state: "ok", detail: assembled ? `${total}/${total} · assembled` : `${total}/${total} broadcast`, pct: 1 });
  if (!assembled) emit({ note: "⚠ assembly not confirmed via dyn-upload — deploying anyway (older node without the endpoint?)" });

  // deploy — at a fresh tick, since the assembly confirm above may have consumed several ticks
  emit({ step: "deploy", state: "active" });
  const deployTick = (await curTick()) + TX_TICK_OFFSET;
  const dr = await broadcastTx(await mk(LITE_TX.DEPLOY, encodeDeploy({ sessionId: session, targetSlot: slot, finalHashHex: hash, name: o.name }), deployTick), o.rpcBase);
  if (!dr.ok) {
    emit({ step: "deploy", state: "fail", detail: `code ${dr.code}` });
    emit({ step: "confirm", state: "fail", detail: "nothing landed" });
    return { ok: false, slot, hash, reason: "not-broadcast", error: "deploy not broadcast" };
  }
  emit({ step: "deploy", state: "ok", detail: `tx ${dr.transactionId ?? "—"}` });   // full txid — copy into the explorer

  if (b.idl) {
    try {
      const p = "qinit.idl.json";
      const all = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
      all[String(slot)] = { name: b.idl.name, functions: b.idl.functions, procedures: b.idl.procedures, codeHash: hash, debugWasm: b.debugWasm ? resolve(b.debugWasm) : undefined, linesJson: b.linesJson ? resolve(b.linesJson) : undefined };
      writeFileSync(p, JSON.stringify(all, null, 2));
    } catch {}
  }

  // confirm — poll dyn-registry until armed && codeHash, then until constructed (INITIALIZE runs a few ticks
  // after arming). "ready" means constructed = callable; an armed-but-unconstructed result is flagged so the
  emit({ step: "confirm", state: "active", detail: "polling arm…" });
  const want = hash.toLowerCase();
  let armed = false, constructed = false, present = false, onNode = "", last = cur, regOk = false;
  let registrationMismatch = false;
  for (let i = 0; i < 420; i++) {   // ~per-second poll budget; early-exits on armed+constructed (slow nodes tick ~8s; the Windows port can stall ticks for minutes)
    await sleep(1000);
    try {
      const ti: any = await rpc.tickInfo(); last = ti.tick ?? last;
      const reg = await rpc.dynRegistry(); regOk = true;
      const c = (reg.contracts ?? []).find((x) => x.index === slot);
      if (c) {
        present = !!c.armed; onNode = (c.codeHash || "").toLowerCase();
        if (c.armed && onNode === want) {
          armed = true;
          const expected = o.artifact?.registration;
          const registrationReady = !expected ||
            ((c.functions?.length ?? 0) === expected.functions && (c.procedures?.length ?? 0) === expected.procedures);
          if (c.constructed && registrationReady) { constructed = true; break; }
          if (c.constructed && !registrationReady) {
            registrationMismatch = true;
            emit({ step: "confirm", state: "active", detail: "armed · registration missing (wasm load failed?)" });
            break;
          }
          emit({ step: "confirm", state: "active", detail: `armed · constructing… tick ${last}` });
          continue;
        }
      }
      emit({ step: "confirm", state: "active", detail: `tick ${last}` });
    } catch {}
  }
  let reason: string | undefined;
  if (armed && !registrationMismatch) {
    // submit this contract's .h to the node so later inter-contract callers can resolve it without --callee.
    try { await rpc.putContractSource(slot, readFileSync(o.contractPath, "utf8")); } catch {}
    if (constructed) emit({ step: "confirm", state: "ok", detail: `ready · ${want.slice(0, 12)}…` });
    else { emit({ step: "confirm", state: "ok", detail: `armed (construct pending) · ${want.slice(0, 12)}…` });
           emit({ note: "⚠ armed but INITIALIZE hasn't settled — a call now may read pre-init state; retry shortly" }); }
  }
  else if (registrationMismatch) {
    reason = "registration-mismatch";
    emit({ step: "confirm", state: "fail", detail: "armed code has no matching WAMR registration table" });
    emit({ note: "slot armed with the expected hash, but the module did not register its functions/procedures — inspect the node's LITEWASM load error" });
  } else {
    const cl = classifyConfirm({ present, regOk, onNode, want });
    reason = cl.reason;
    emit({ step: "confirm", state: "fail", detail: cl.detail });
    emit({ note: cl.note });
  }

  return { ok: armed && !registrationMismatch, slot, reused, hash, txId: dr.transactionId, armed, constructed, reason, idl: b.idl };
}
