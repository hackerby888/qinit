import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  buildContractWithWasiClang,
  systemNames,
  type ContractBuildResult,
  type ContractIdl,
} from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import {
  LiteRpc,
  k12Hex,
  readCurrent,
  autoUpdateVerifyTool,
  type NodeBackendIdentity,
} from "@qinit/core";
import {
  encodeDeploy,
  LITE_TX,
  resolveDeploymentSlot,
  TX_TICK_OFFSET,
} from "@qinit/proto";
import {
  savedSeed,
  savedCompilerBackend,
  resolveCoreDir,
  type CompilerBackend,
} from "../../config";
import { buildContractWithTypeScript } from "../typescript-build";
import { saveContractIdl } from "../../contracts/idl-file";
import { resolveNodeCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";
import { classifyConfirm, tickFailureMessage, type DeploymentEvent } from "./steps";
import { activeUploadError, buildUploadTx, uploadContract } from "./upload";
import { resolveFundedSigner, unfundedSignerMessage } from "../signer";
export { resolveNodeCallees } from "../../contracts/callees";
export {
  STEPS,
  classifyConfirm,
  tickFailureMessage,
  updateDeploymentSteps,
} from "./steps";
export type {
  DeploymentEvent,
  DeploymentStepEvent,
  DeploymentStepState,
  StepKey,
} from "./steps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeployOpts {
  contractPath: string;
  name: string;
  core: string;
  rpcBaseUrl: string;
  seed?: string;
  dynCallees?: Record<string, { header: string; index: number }>;
  slotOverride?: number;
  outDir?: string;
  idlPath?: string;
  skipVerify?: boolean;
  compiler?: CompilerBackend;
  backend?: NodeBackendIdentity["backend"];
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

export async function deployContract(
  options: DeployOpts,
  emit: (event: DeploymentEvent) => void,
): Promise<DeployResult> {
  const slotOverride =
    options.slotOverride === undefined
      ? undefined
      : parseContractSlot(options.slotOverride);
  const rpc = options.rpc ?? new LiteRpc(options.rpcBaseUrl);

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
    if (systemNames(resolveCoreDir(options.core)).has(options.name.toLowerCase())) {
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
      note: `⚠ version drift: headers ${pin.headersVersion} ≠ node ${pin.nodeVersion} — run 'qinit setup'`,
    });
  }

  if (!options.artifact) {
    const verifyUpdate = await autoUpdateVerifyTool();
    if (verifyUpdate.action === "updated" || verifyUpdate.action === "installed") {
      emit({
        note: `↻ contractverify ${verifyUpdate.action} → ${verifyUpdate.version}`,
      });
    }
  }

  emit({ step: "tick", state: "active", detail: "waiting for node…" });
  let initialTick = -1;
  let currentTick = 0;
  let reached = false;
  let misses = 0;

  for (let i = 0; i < 300; i++) {
    try {
      const tickInfo = await rpc.tickInfo();
      reached = true;
      misses = 0;
      currentTick = tickInfo.tick;
      if (initialTick < 0) {
        initialTick = currentTick;
        // A dev node jumps the readiness margin at once; one that cannot answers 0 and the loop waits.
        currentTick = Math.max(currentTick, await rpc.hurryToTick(initialTick + 4));
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
    return { ok: false, error: tickFailureMessage(reached, options.rpcBaseUrl) };
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
  const { slot, reused } = await resolveDeploymentSlot(
    rpc,
    options.name,
    slotOverride,
  );
  emit({
    step: "slot",
    state: "ok",
    detail: `slot ${slot} ${reused ? "(reuse)" : "(new)"}`,
  });

  const discoveredCallees = options.artifact
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
  const dynCallees = Object.fromEntries(
    Object.entries(discoveredCallees).map(([name, callee]) => {
      if (callee.index === undefined) {
        throw new Error(
          `callee '${name}' has no slot; use the project deployment planner or pass --callee ${name}=path@index`,
        );
      }
      return [name, { header: callee.header, index: callee.index }];
    }),
  );

  const compiler: CompilerBackend =
    options.compiler ?? savedCompilerBackend() ?? "clang";
  const outDir = options.outDir ?? resolve("dist/contracts");
  if (options.artifact) {
    emit({ note: "compiler: prebuilt artifact (exact bytes)" });
  } else if (compiler === "typescript") {
    emit({ note: "compiler: TypeScript (qinit compiler typescript)" });
  }

  emit({
    step: "build",
    state: "active",
    detail: options.artifact
      ? "validating prebuilt bytes…"
      : compiler === "typescript"
        ? "compiling (TypeScript)…"
        : "compiling…",
  });
  const build: ContractBuildResult = options.artifact
    ? { ok: options.artifact.wasm.byteLength > 0, idl: options.artifact.idl }
    : compiler === "typescript"
      ? await buildContractWithTypeScript({
          contractPath: options.contractPath,
          name: options.name,
          slot,
          core: options.core,
          outDir,
          dynCallees,
        })
      : await buildContractWithWasiClang({
          contractPath: options.contractPath,
          name: options.name,
          slot,
          corePath: options.core,
          outDir,
          dynCallees,
          skipVerify: options.skipVerify,
        });

  if (!build.ok) {
    const verification = build.verify;
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
    : readFileSync(build.wasmPath!);
  const hash =
    options.artifact?.hash ??
    build.wasmK12DigestHex ??
    (await k12Hex(new Uint8Array(wasm)));
  emit({
    step: "build",
    state: "ok",
    detail: `${wasm.length}B · k12 ${hash}`,
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
        debugWasm: build.debugWasmPath ? resolve(build.debugWasmPath) : undefined,
        linesJson: build.lineMapPath ? resolve(build.lineMapPath) : undefined,
      }, options.idlPath);
    } catch (error: any) {
      emit({ note: `IDL: ${String(error?.message ?? error)}` });
    }
  };

  const backend = options.backend ?? (await rpc.whoami()).backend;
  if (backend !== "core" && backend !== "simulator") {
    return {
      ok: false,
      slot,
      hash,
      error: `unsupported runtime '${String(backend)}'`,
    };
  }

  if (backend === "simulator") {
    const directDeployment = await rpc.directDeploy(
      slot,
      new Uint8Array(wasm),
      options.name,
      "dynamic",
    );
    if (!directDeployment) {
      return {
        ok: false,
        slot,
        hash,
        error: "simulator does not expose direct deployment; upgrade the Qinit simulator",
      };
    }

    emit({ step: "upload", state: "ok", detail: "direct (simulator)" });
    emit({ step: "deploy", state: "ok", detail: `slot ${slot}` });

    try {
      await rpc.putContractSource(slot, readFileSync(options.contractPath, "utf8"));
    } catch {
      // Source metadata is optional for a successful deployment.
    }

    saveIdl();
    emit({ step: "confirm", state: "ok", detail: `ready · ${hash}` });
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

  // Only this path signs anything — the direct route above deploys without a transaction, so a node that
  // reports no balance for the seed cannot fail a simulator deploy.
  const signer = await resolveFundedSigner(rpc, seed, {
    explicit: Boolean(options.seed),
  });
  if (signer.switched) {
    emit({
      note: `⚠ seed unfunded here — signing with the node's funded seed (${signer.identity})`,
    });
    seed = signer.seed;
  } else if (signer.unfunded) {
    emit({ step: "upload", state: "fail", detail: "signer unfunded" });
    return { ok: false, slot, hash, error: unfundedSignerMessage(signer.identity) };
  }

  try {
    const tickInfo = await rpc.tickInfo();
    currentTick = tickInfo.tick;
  } catch {
    // The last tick from the readiness probe remains usable.
  }

  const readTick = async () => {
    try {
      const tickInfo = await rpc.tickInfo();
      return tickInfo.tick;
    } catch {
      return currentTick;
    }
  };

  const waitForTick = async (target: number, attempts = 300) => {
    let tick = await rpc.hurryToTick(target);
    for (let i = 0; i < attempts && tick < target; i++) {
      tick = await readTick();
      if (tick >= target) {
        break;
      }
      await sleep(1000);
    }
    return tick;
  };

  // Upload spends a transaction per tick, so a crawling chain fails slowly. Only worth measuring on a
  // node we cannot drive ourselves.
  const driveable = (await rpc.hurryToTick(currentTick + 3)) >= currentTick + 3;
  if (!driveable) {
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
  const upload = await uploadContract({
    rpc,
    seed,
    wasm: new Uint8Array(wasm),
    hash,
    emit,
    readTick,
    waitForTick,
  });
  if (!upload.ok) {
    return { ok: false, slot, hash, error: upload.error };
  }
  const session = upload.session;

  emit({ step: "deploy", state: "active" });
  const deployTick = (await readTick()) + TX_TICK_OFFSET;
  const deployResult = await rpc.broadcastTx(
    await buildUploadTx(
      seed,
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
  // The DEPLOY tx sits three ticks out; arming and INITIALIZE follow, so the poll below still runs.
  await rpc.hurryToTick(deployTick + 1);
  const expectedHash = hash.toLowerCase();
  let armed = false;
  let constructed = false;
  let present = false;
  let onNode = "";
  let lastTick = currentTick;
  let registryRead = false;
  let registrationMismatch = false;

  for (let i = 0; i < 420; i++) {
    // Arming and INITIALIZE each need a tick: drive them when the node allows it, wait otherwise.
    if (i > 0 && (await rpc.hurryToTick(lastTick + 1)) <= lastTick) {
      await sleep(1000);
    }

    try {
      const tickInfo = await rpc.tickInfo();
      lastTick = tickInfo.tick;
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
        detail: `ready · ${expectedHash}`,
      });
    } else {
      emit({
        step: "confirm",
        state: "ok",
        detail: `armed (construct pending) · ${expectedHash}`,
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
