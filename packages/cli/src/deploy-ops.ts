import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildContract,
  scanCallees,
  systemNames,
  type BuildResult,
  type ContractIdl,
} from "@qinit/build";
import { loadQpiHeader } from "@qinit/compile";
import {
  buildSignedTx,
  LiteRpc,
  k12Hex,
  readCurrent,
  autoUpdateVerifyTool,
} from "@qinit/core";
import {
  encodeUploadBegin,
  encodeUploadChunk,
  encodeDeploy,
  chunkSo,
  newSessionId,
  LITE_TX,
  resolveSlot,
  TX_TICK_OFFSET,
} from "@qinit/proto";
import { savedSeed, savedCompiler, resolveCore, type Compiler } from "./config";
import { compileLocal } from "./compile-local";
import { saveContractIdl } from "./idl-file";

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

export function tickFailureMessage(reached: boolean, rpcBase: string): string {
  return reached
    ? "node not ticking"
    : `node unreachable at ${rpcBase} — is it running? (qinit node run)`;
}

export async function resolveNodeCallees(
  rpc: Pick<LiteRpc, "dynRegistry">,
  contractSource: string,
  dynCallees: Record<string, { header: string; index: number }> = {},
  onNote?: (message: string) => void,
  analysis?: { name: string; slot: number; qpiHeader: string },
  timeoutMs?: number,
): Promise<Record<string, { header: string; index: number }>> {
  const resolved: Record<string, { header: string; index: number }> = { ...dynCallees };

  try {
    const names = [...scanCallees(contractSource, analysis)];
    const pending = names.filter((name) => !resolved[name]);
    if (!pending.length) {
      return resolved;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = rpc.dynRegistry();
    const registry = timeoutMs
      ? await Promise.race([
          probe.finally(() => clearTimeout(timer)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("node probe timeout")),
              timeoutMs,
            );
          }),
        ])
      : await probe;

    for (const name of pending) {
      const contract = (registry.contracts ?? []).find(
        (candidate) => candidate.name === name && candidate.armed && candidate.source,
      );
      if (contract) {
        const header = join(tmpdir(), `qinit-callee-${name}.h`);
        writeFileSync(header, contract.source!);
        resolved[name] = { header, index: contract.index };
        onNote?.(`callee ${name} → slot ${contract.index} (from node)`);
      }
    }
  } catch {
    // Callee discovery is optional when the node is unavailable.
  }

  return resolved;
}

export function classifyConfirm(state: {
  present: boolean;
  regOk: boolean;
  onNode: string;
  want: string;
}): { reason: string; detail: string; note: string } {
  if (!state.regOk) {
    return {
      reason: "registry-unreadable",
      detail: "couldn't read dyn-registry",
      note: "couldn't read /dyn-registry (node too old or RPC down) — deploy state unknown",
    };
  }

  if (!state.present) {
    return {
      reason: "empty",
      detail: "slot empty — didn't land",
      note: "upload/deploy didn't land (chunks dropped, tick missed, or seed unfunded)",
    };
  }

  return {
    reason: "wrong-code",
    detail: "different code — didn't take",
    note: `on-node ${state.onNode.slice(0, 12)}… ≠ yours ${state.want.slice(0, 12)}…`,
  };
}

export interface DeployOpts {
  contractPath: string;
  name: string;
  core: string;
  rpcBase: string;
  seed?: string;
  dynCallees?: Record<string, { header: string; index: number }>;
  slotOverride?: number;
  outDir?: string;
  skipVerify?: boolean;
  compiler?: Compiler;
  artifact?: {
    wasm: Uint8Array;
    hash?: string;
    idl?: ContractIdl;
    registration?: { functions: number; procedures: number };
  };
  rpc?: LiteRpc;
}
export interface DeployResult {
  ok: boolean;
  slot?: number;
  reused?: boolean;
  hash?: string;
  txId?: string;
  armed?: boolean;
  constructed?: boolean;
  reason?: string;
  idl?: ContractIdl;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function activeUploadError(upload: {
  sessionId: string;
  receivedCount: number;
  chunkCount: number;
}): string {
  return `another contract upload is active (session ${upload.sessionId}, ${upload.receivedCount}/${upload.chunkCount} chunks); wait for it to complete`;
}

export async function deployContract(
  options: DeployOpts,
  emit: (event: Ev) => void,
): Promise<DeployResult> {
  const rpc = options.rpc ?? new LiteRpc(options.rpcBase);

  // Reject a competing upload before doing build or network work.
  try {
    const upload = await rpc.dynUpload();
    if (upload.active) {
      const error = activeUploadError(upload);
      emit({ step: "upload", state: "fail", detail: error });
      return { ok: false, error };
    }
  } catch {
    // Older nodes do not expose dyn-upload; the normal reachability check below remains authoritative.
  }

  try {
    if (systemNames(resolveCore(options.core)).has(options.name.toLowerCase())) {
      emit({
        step: "build",
        state: "fail",
        detail: `'${options.name}' is a system contract name`,
      });
      return {
        ok: false,
        error: `'${options.name}' is a reserved system contract name — pick another`,
      };
    }
  } catch {
    // The build step reports a missing core snapshot with more context.
  }

  const pin = readCurrent();
  if (pin?.headersVersion && pin?.nodeVersion && pin.headersVersion !== pin.nodeVersion) {
    emit({
      note: `⚠ version drift: headers ${pin.headersVersion} ≠ node ${pin.nodeVersion} — run 'qinit node run'`,
    });
  }

  const verifyUpdate = await autoUpdateVerifyTool();
  if (verifyUpdate.action === "updated" || verifyUpdate.action === "installed") {
    emit({
      note: `↻ contractverify ${verifyUpdate.action} → ${verifyUpdate.version}`,
    });
  }

  emit({ step: "tick", state: "active", detail: "waiting for node…" });
  let initialTick = -1;
  let currentTick = 0;
  let reached = false;
  let misses = 0;

  for (let i = 0; i < 300; i++) {
    try {
      const tickInfo: any = await rpc.tickInfo();
      reached = true;
      misses = 0;
      currentTick = tickInfo.tick ?? tickInfo.currentTick ?? 0;
      if (initialTick < 0) {
        initialTick = currentTick;
      }
      emit({ step: "tick", state: "active", detail: `tick ${currentTick}` });
      if (currentTick > initialTick + 3) {
        break;
      }
    } catch {
      misses++;
      if (!reached && misses >= 15) {
        break;
      }
    }
    await sleep(1000);
  }

  if (!reached || currentTick <= initialTick + 3) {
    emit({ step: "tick", state: "fail", detail: reached ? "not ticking" : "unreachable" });
    return { ok: false, error: tickFailureMessage(reached, options.rpcBase) };
  }

  emit({ step: "tick", state: "ok", detail: `tick ${currentTick}` });

  let seed = options.seed;
  if (!seed) {
    const saved = savedSeed();
    if (saved) {
      seed = saved;
      emit({ note: "using saved seed (qinit seed)" });
    }
  }
  if (!seed) {
    const funded = await rpc.fundedSeed();
    if (funded) {
      seed = funded;
      emit({ note: "using node funded seed" });
    }
  }
  seed = seed ?? "a".repeat(55);

  emit({ step: "slot", state: "active" });
  const { slot, reused } = await resolveSlot(rpc, options.name, options.slotOverride);
  emit({
    step: "slot",
    state: "ok",
    detail: `slot ${slot} ${reused ? "(reuse)" : "(new)"}`,
  });

  const dynCallees = options.artifact
    ? options.dynCallees ?? {}
    : await resolveNodeCallees(
        rpc,
        readFileSync(options.contractPath, "utf8"),
        options.dynCallees ?? {},
        (note) => emit({ note }),
        {
          name: options.name,
          slot,
          qpiHeader: loadQpiHeader(options.core),
        },
      );

  const compiler: Compiler = options.compiler ?? savedCompiler() ?? "native";
  const outDir = options.outDir ?? resolve("dist/contracts");
  if (options.artifact) {
    emit({ note: "compiler: prebuilt artifact (exact bytes)" });
  } else if (compiler === "local") {
    emit({ note: "compiler: local TS (qinit compiler local)" });
  }

  emit({
    step: "build",
    state: "active",
    detail: options.artifact
      ? "validating prebuilt bytes…"
      : compiler === "local"
        ? "compiling (local TS)…"
        : "compiling…",
  });
  const build: any = options.artifact
    ? { ok: options.artifact.wasm.byteLength > 0, idl: options.artifact.idl }
    : compiler === "local"
      ? await compileLocal({
          contractPath: options.contractPath,
          name: options.name,
          slot,
          core: options.core,
          outDir,
          dynCallees,
        })
      : await buildContract({
          contractPath: options.contractPath,
          name: options.name,
          slot,
          corePath: options.core,
          outDir,
          dynCallees,
          skipVerify: options.skipVerify,
        });

  if (!build.ok) {
    const verification = (build as BuildResult).verify;
    const error =
      verification && !verification.ok && verification.errors.length
        ? `protocol: ${verification.errors[0]}`
        : "compile failed";
    emit({ step: "build", state: "fail", detail: error });
    emit({ note: (build.stderr ?? "").split("\n").slice(0, 14).join("\n") });
    return { ok: false, slot, error };
  }

  const wasm = options.artifact
    ? Buffer.from(options.artifact.wasm)
    : readFileSync(build.so!);
  const hash =
    options.artifact?.hash ??
    build.hash ??
    (await k12Hex(new Uint8Array(wasm)));
  emit({
    step: "build",
    state: "ok",
    detail: `${wasm.length}B · k12 ${hash.slice(0, 12)}…`,
  });
  if (build.idlError) {
    emit({
      note:
        "⚠ compiler IDL analysis failed — no typed client/state names: " +
        build.idlError,
    });
  }

  const saveIdl = () => {
    if (!build.idl) {
      return;
    }

    try {
      saveContractIdl(slot, {
        ...build.idl,
        slot,
        codeHash: hash,
        debugWasm: build.debugWasm ? resolve(build.debugWasm) : undefined,
        linesJson: build.linesJson ? resolve(build.linesJson) : undefined,
      });
    } catch (error: any) {
      emit({ note: `IDL: ${String(error?.message ?? error)}` });
    }
  };

  const directDeployment = await rpc
    .directDeploy(slot, new Uint8Array(wasm), options.name)
    .catch(() => null);
  if (directDeployment) {
    emit({ step: "upload", state: "ok", detail: "direct (virtualnode)" });
    emit({ step: "deploy", state: "ok", detail: `slot ${slot}` });

    try {
      await rpc.putContractSource(slot, readFileSync(options.contractPath, "utf8"));
    } catch {
      // Source metadata is optional for a successful deployment.
    }

    saveIdl();
    emit({ step: "confirm", state: "ok", detail: `ready · ${hash.slice(0, 12)}…` });
    return {
      ok: true,
      slot,
      reused,
      hash,
      armed: true,
      constructed: true,
      idl: build.idl,
    };
  }

  try {
    const tickInfo: any = await rpc.tickInfo();
    currentTick = tickInfo.tick ?? currentTick;
  } catch {
    // The last tick from the readiness probe remains usable.
  }

  const readTick = async () => {
    try {
      const tickInfo: any = await rpc.tickInfo();
      return (tickInfo.tick ?? tickInfo.currentTick ?? currentTick) as number;
    } catch {
      return currentTick;
    }
  };

  const waitForTick = async (target: number, attempts = 300) => {
    let tick = currentTick;
    for (let i = 0; i < attempts; i++) {
      tick = await readTick();
      if (tick >= target) {
        break;
      }
      await sleep(1000);
    }
    return tick;
  };

  {
    const startedAt = Date.now();
    const baseTick = currentTick;
    let ticksAdvanced = 0;

    while (Date.now() - startedAt < 30000) {
      await sleep(2000);
      ticksAdvanced = (await readTick()) - baseTick;
      if (ticksAdvanced >= 3) {
        break;
      }
    }

    if (ticksAdvanced < 2) {
      const secondsPerTick =
        ticksAdvanced > 0
          ? Math.round((Date.now() - startedAt) / 1000 / ticksAdvanced)
          : Infinity;
      const speed = secondsPerTick === Infinity ? ">30" : String(secondsPerTick);
      emit({
        step: "upload",
        state: "fail",
        detail: `chain too slow (~${speed}s/tick)`,
      });
      return {
        ok: false,
        slot,
        hash,
        error: `node ticking far too slowly (~${speed}s/tick) to deploy within budget — aborting before upload (under-provisioned runner?)`,
      };
    }
  }

  currentTick = await readTick();
  const session = newSessionId();
  const chunks = chunkSo(new Uint8Array(wasm));
  const total = chunks.length + 1;
  const sentIndexes = new Set<number>();
  const buildTransaction = async (
    inputType: number,
    payload: Uint8Array,
    tick: number,
  ) => (await buildSignedTx(seed!, { tick, inputType, payload })).bytes;

  emit({ step: "upload", state: "active", detail: `0/${total}`, pct: 0 });

  // Claim the single upload slot before any chunk leaves this client.
  const claimUpload = async (): Promise<{ owned: boolean; error?: string }> => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const tick = (await readTick()) + TX_TICK_OFFSET;
      let sent = false;

      try {
        sent = (
          await rpc.broadcastTx(
            await buildTransaction(
              LITE_TX.UPLOAD_BEGIN,
              encodeUploadBegin({
                sessionId: session,
                totalSize: wasm.length,
                chunkCount: chunks.length,
                finalHashHex: hash,
              }),
              tick,
            ),
          )
        ).ok;
      } catch {
        // A fresh tick below retries transient broadcast failures.
      }

      if (sent) {
        sentIndexes.add(0);
        emit({
          step: "upload",
          state: "active",
          detail: `${sentIndexes.size}/${total}`,
          pct: sentIndexes.size / total,
        });
        await waitForTick(tick + 1);
      }

      try {
        const upload = await rpc.dynUpload();
        if (upload.active) {
          if (upload.sessionId === String(session)) {
            return { owned: true };
          }
          return { owned: false, error: activeUploadError(upload) };
        }
      } catch {
        // Older nodes may not expose upload status during the retry window.
      }

      if (attempt < 3) {
        emit({ note: `retry ${attempt + 1}: UPLOAD_BEGIN not confirmed` });
        await sleep(600);
      }
    }

    return { owned: false, error: "upload begin not confirmed after retries" };
  };

  const claim = await claimUpload();
  if (!claim.owned) {
    emit({ step: "upload", state: "fail", detail: claim.error });
    return { ok: false, slot, hash, error: claim.error };
  }

  const chunkTick = (await readTick()) + TX_TICK_OFFSET;
  let pendingChunks = await Promise.all(
    chunks.map(async (bytes, seq) => ({
      bytes: await buildTransaction(
        LITE_TX.UPLOAD_CHUNK,
        encodeUploadChunk({ sessionId: session, seq, bytes }),
        chunkTick,
      ),
      index: seq + 1,
    })),
  );

  for (let attempt = 0; attempt <= 3 && pendingChunks.length; attempt++) {
    const failedChunks: typeof pendingChunks = [];

    for (const chunk of pendingChunks) {
      try {
        const result = await rpc.broadcastTx(chunk.bytes);
        if (result.ok) {
          sentIndexes.add(chunk.index);
        } else {
          failedChunks.push(chunk);
        }
      } catch {
        failedChunks.push(chunk);
      }

      emit({
        step: "upload",
        state: "active",
        detail: `${sentIndexes.size}/${total}`,
        pct: sentIndexes.size / total,
      });
    }

    pendingChunks = failedChunks;
    if (pendingChunks.length) {
      emit({ note: `retry ${attempt + 1}: ${pendingChunks.length} chunk(s)` });
      await sleep(600);
    }
  }

  if (sentIndexes.size < total) {
    emit({
      step: "upload",
      state: "fail",
      detail: `${sentIndexes.size}/${total}`,
    });
    emit({
      note: `✗ ${total - sentIndexes.size} upload tx(s) failed after retries`,
    });
    return { ok: false, slot, hash, error: "upload failed" };
  }
  emit({
    step: "upload",
    state: "active",
    detail: `${total}/${total} broadcast · confirming…`,
    pct: 1,
  });

  // A successful broadcast does not guarantee that the chunk landed in a tick.
  let assembled = false;
  await waitForTick(chunkTick + 1);

  for (let round = 0; round < 4 && !assembled; round++) {
    let upload: Awaited<ReturnType<typeof rpc.dynUpload>> | null = null;

    try {
      upload = await rpc.dynUpload();
    } catch {
      // Older nodes may not expose upload status.
    }

    if (upload?.active && upload.sessionId !== String(session)) {
      const error = activeUploadError(upload);
      emit({ step: "upload", state: "fail", detail: error });
      return { ok: false, slot, hash, error };
    }

    if (upload?.active) {
      if (upload.complete) {
        assembled = true;
        break;
      }

      const missing = (upload.missing ?? []).filter((seq) => seq < chunks.length);
      if (!missing.length) {
        await waitForTick((await readTick()) + 1);
        continue;
      }

      const resendTick = (await readTick()) + TX_TICK_OFFSET;
      for (const seq of missing) {
        await rpc.broadcastTx(
          await buildTransaction(
            LITE_TX.UPLOAD_CHUNK,
            encodeUploadChunk({ sessionId: session, seq, bytes: chunks[seq] }),
            resendTick,
          ),
        );
      }

      emit({
        note: `assembly: resent ${missing.length} missing chunk(s) [round ${round + 1}]`,
      });
      await waitForTick(resendTick + 1);
    } else {
      await waitForTick((await readTick()) + 1);
    }
  }

  emit({
    step: "upload",
    state: "ok",
    detail: assembled ? `${total}/${total} · assembled` : `${total}/${total} broadcast`,
    pct: 1,
  });
  if (!assembled) {
    emit({
      note: "⚠ assembly not confirmed via dyn-upload — deploying anyway (older node without the endpoint?)",
    });
  }

  emit({ step: "deploy", state: "active" });
  const deployTick = (await readTick()) + TX_TICK_OFFSET;
  const deployResult = await rpc.broadcastTx(
    await buildTransaction(
      LITE_TX.DEPLOY,
      encodeDeploy({ sessionId: session, targetSlot: slot, finalHashHex: hash, name: options.name }),
      deployTick,
    ),
  );

  if (!deployResult.ok) {
    emit({ step: "deploy", state: "fail", detail: `code ${deployResult.code}` });
    emit({ step: "confirm", state: "fail", detail: "nothing landed" });
    return {
      ok: false,
      slot,
      hash,
      reason: "not-broadcast",
      error: "deploy not broadcast",
    };
  }

  emit({
    step: "deploy",
    state: "ok",
    detail: `tx ${deployResult.transactionId ?? "—"}`,
  });

  emit({ step: "confirm", state: "active", detail: "polling arm…" });
  const expectedHash = hash.toLowerCase();
  let armed = false;
  let constructed = false;
  let present = false;
  let onNode = "";
  let lastTick = currentTick;
  let registryRead = false;
  let registrationMismatch = false;

  for (let i = 0; i < 420; i++) {
    await sleep(1000);

    try {
      const tickInfo: any = await rpc.tickInfo();
      lastTick = tickInfo.tick ?? lastTick;
      const registry = await rpc.dynRegistry();
      registryRead = true;
      const contract = (registry.contracts ?? []).find(
        (candidate) => candidate.index === slot,
      );

      if (contract) {
        present = !!contract.armed;
        onNode = (contract.codeHash || "").toLowerCase();

        if (contract.armed && onNode === expectedHash) {
          armed = true;
          const expected = options.artifact?.registration;
          const registrationReady =
            !expected ||
            ((contract.functions?.length ?? 0) === expected.functions &&
              (contract.procedures?.length ?? 0) === expected.procedures);

          if (contract.constructed && registrationReady) {
            constructed = true;
            break;
          }

          if (contract.constructed && !registrationReady) {
            registrationMismatch = true;
            emit({
              step: "confirm",
              state: "active",
              detail: "armed · registration missing (wasm load failed?)",
            });
            break;
          }

          emit({
            step: "confirm",
            state: "active",
            detail: `armed · constructing… tick ${lastTick}`,
          });
          continue;
        }
      }

      emit({ step: "confirm", state: "active", detail: `tick ${lastTick}` });
    } catch {
      // Keep polling through transient RPC failures.
    }
  }

  let reason: string | undefined;
  if (armed && !registrationMismatch) {
    try {
      await rpc.putContractSource(slot, readFileSync(options.contractPath, "utf8"));
    } catch {
      // Source metadata is optional for a successful deployment.
    }

    saveIdl();
    if (constructed) {
      emit({
        step: "confirm",
        state: "ok",
        detail: `ready · ${expectedHash.slice(0, 12)}…`,
      });
    } else {
      emit({
        step: "confirm",
        state: "ok",
        detail: `armed (construct pending) · ${expectedHash.slice(0, 12)}…`,
      });
      emit({
        note: "⚠ armed but INITIALIZE hasn't settled — a call now may read pre-init state; retry shortly",
      });
    }
  } else if (registrationMismatch) {
    reason = "registration-mismatch";
    emit({
      step: "confirm",
      state: "fail",
      detail: "armed code has no matching WAMR registration table",
    });
    emit({
      note: "slot armed with the expected hash, but the module did not register its functions/procedures — inspect the node's LITEWASM load error",
    });
  } else {
    const classification = classifyConfirm({
      present,
      regOk: registryRead,
      onNode,
      want: expectedHash,
    });
    reason = classification.reason;
    emit({ step: "confirm", state: "fail", detail: classification.detail });
    emit({ note: classification.note });
  }

  return {
    ok: armed && !registrationMismatch,
    slot,
    reused,
    hash,
    txId: deployResult.transactionId,
    armed,
    constructed,
    reason,
    idl: build.idl,
  };
}
