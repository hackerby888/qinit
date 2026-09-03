import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { buildContractWithClang, type ContractBuildResult, type ContractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import { LiteRpc, k12Hex, type NodeBackendIdentity } from "@qinit/core";
import { encodeDeploy, LITE_TX, resolveDeploymentSlot, TX_TICK_OFFSET } from "@qinit/proto";
import { savedCompilerBackend, type CompilerBackend } from "../../config";
import { buildContractWithTypeScript } from "../typescript-build";
import { saveContractIdl } from "../../contracts/idl-file";
import { resolveNodeCallees } from "../../contracts/callees";
import { parseContractSlot } from "../../contracts/registry";
import { classifyConfirm, type DeploymentEvent } from "./steps";
import { buildUploadTx, uploadContract } from "./upload";
import { resolveFundedSigner, unfundedSignerMessage } from "../signer";
import { assertChainFastEnough, deployToSimulator, resolveSigningSeed, runPreflightChecks, waitForTickReadiness } from "./phases";
export { resolveNodeCallees } from "../../contracts/callees";
export { STEPS, classifyConfirm, tickFailureMessage, updateDeploymentSteps } from "./steps";
export type { DeploymentEvent, DeploymentStepEvent, DeploymentStepState, StepKey } from "./steps";

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

export async function deployContract(options: DeployOpts, emit: (event: DeploymentEvent) => void): Promise<DeployResult> {
    const slotOverride = options.slotOverride === undefined ? undefined : parseContractSlot(options.slotOverride);
    const rpc = options.rpc ?? new LiteRpc(options.rpcBaseUrl);

    const preflight = await runPreflightChecks(rpc, options, emit);
    if (preflight) {
        return { ok: false, error: preflight.error };
    }

    const readiness = await waitForTickReadiness(rpc, options.rpcBaseUrl, emit);
    if (!readiness.ok) {
        return { ok: false, error: readiness.error };
    }
    let currentTick = readiness.tick;

    let seed = await resolveSigningSeed(rpc, options.seed, emit);

    emit({ step: "slot", state: "active" });
    const { slot, reused } = await resolveDeploymentSlot(rpc, options.name, slotOverride);
    emit({
        step: "slot",
        state: "ok",
        detail: `slot ${slot} ${reused ? "(reuse)" : "(new)"}`,
    });

    const discoveredCallees = options.artifact
        ? (options.dynCallees ?? {})
        : await resolveNodeCallees(rpc, readFileSync(options.contractPath, "utf8"), options.dynCallees ?? {}, (note) => emit({ note }), {
              name: options.name,
              slot,
              qpiHeader: loadQpiHeader(options.core),
          });
    const dynCallees = Object.fromEntries(
        Object.entries(discoveredCallees).map(([name, callee]) => {
            if (callee.index === undefined) {
                throw new Error(`callee '${name}' has no slot; use the project deployment planner or pass --callee ${name}=path@index`);
            }
            return [name, { header: callee.header, index: callee.index }];
        }),
    );

    const compiler: CompilerBackend = options.compiler ?? savedCompilerBackend() ?? "clang";
    const outDir = options.outDir ?? resolve("dist/contracts");
    if (options.artifact) {
        emit({ note: "compiler: prebuilt artifact (exact bytes)" });
    } else if (compiler === "typescript") {
        emit({ note: "compiler: TypeScript (qinit compiler typescript)" });
    }

    emit({
        step: "build",
        state: "active",
        detail: options.artifact ? "validating prebuilt bytes…" : compiler === "typescript" ? "compiling (TypeScript)…" : "compiling…",
    });
    const build: ContractBuildResult = options.artifact
        ? { ok: options.artifact.wasm.byteLength > 0, idl: options.artifact.idl }
        : compiler === "typescript"
          ? await buildContractWithTypeScript({
                contractPath: options.contractPath,
                contractName: options.name,
                slot,
                corePath: options.core,
                outDir,
                dynCallees,
                skipVerify: options.skipVerify,
            })
          : await buildContractWithClang({
                contractPath: options.contractPath,
                contractName: options.name,
                slot,
                corePath: options.core,
                outDir,
                dynCallees,
                skipVerify: options.skipVerify,
            });

    if (!build.ok) {
        const verification = build.verify;
        const error = verification && !verification.ok && verification.errors.length ? `protocol: ${verification.errors[0]}` : "compile failed";
        emit({ step: "build", state: "fail", detail: error });
        emit({ note: (build.stderr ?? "").split("\n").slice(0, 14).join("\n") });
        return { ok: false, slot, error };
    }

    const wasm = options.artifact ? Buffer.from(options.artifact.wasm) : readFileSync(build.wasmPath!);
    const hash = options.artifact?.hash ?? build.wasmK12DigestHex ?? (await k12Hex(new Uint8Array(wasm)));
    emit({
        step: "build",
        state: "ok",
        detail: `${wasm.length}B · k12 ${hash}`,
    });
    if (build.idlError) {
        emit({
            note: "⚠ compiler IDL analysis failed — no typed client/state names: " + build.idlError,
        });
    }

    const saveIdl = () => {
        if (!build.idl) {
            return;
        }

        try {
            saveContractIdl(
                slot,
                {
                    ...build.idl,
                    slot,
                    codeHash: hash,
                    debugWasm: build.debugWasmPath ? resolve(build.debugWasmPath) : undefined,
                    linesJson: build.lineMapPath ? resolve(build.lineMapPath) : undefined,
                },
                options.idlPath,
            );
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
        const direct = await deployToSimulator({
            rpc,
            slot,
            wasm: new Uint8Array(wasm),
            hash,
            name: options.name,
            contractPath: options.contractPath,
            saveIdl,
            emit,
        });
        if (!direct.ok) {
            return { ok: false, slot, hash, error: direct.error };
        }

        return { ok: true, slot, reused, hash, armed: true, constructed: true, idl: build.idl };
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

    const slowChain = await assertChainFastEnough(rpc, currentTick, readTick, emit);
    if (slowChain) {
        return { ok: false, slot, hash, error: slowChain.error };
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

    // A DEPLOY names the tick it must execute in, so a client that spends longer than TX_TICK_OFFSET
    // ticks signing and broadcasting has its transaction dropped for a tick that already passed. The
    // node clears the upload session on a successful deploy, so a resend of one that did land is
    // refused at the session check rather than re-arming the slot.
    const broadcastDeploy = async () => {
        const tick = (await readTick()) + TX_TICK_OFFSET;
        const result = await rpc.broadcastTx(
            await buildUploadTx(
                seed,
                LITE_TX.DEPLOY,
                encodeDeploy({
                    sessionId: session,
                    targetSlot: slot,
                    finalHashHex: hash,
                    name: options.name,
                }),
                tick,
            ),
        );
        return { ok: result.ok, code: result.code, transactionId: result.transactionId, tick };
    };

    let deployResult = await broadcastDeploy();
    let deployTick = deployResult.tick;

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
    // Ticks past the target to allow before calling the transaction lost, and how many times to resend.
    const DEPLOY_MISS_GRACE_TICKS = 3;
    const DEPLOY_MAX_RESENDS = 3;
    let deployResends = 0;
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
            const contract = (registry.contracts ?? []).find((candidate) => candidate.index === slot);

            if (contract) {
                present = !!contract.armed;
                onNode = (contract.codeHash || "").toLowerCase();

                if (contract.armed && onNode === expectedHash) {
                    armed = true;
                    const expected = options.artifact?.registration;
                    const registrationReady =
                        !expected || ((contract.functions?.length ?? 0) === expected.functions && (contract.procedures?.length ?? 0) === expected.procedures);

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

            // Its tick is well past and the slot has not changed, so the transaction is gone. A fresh
            // one costs a tick; waiting out the rest of this poll costs minutes and still fails.
            if (lastTick > deployTick + DEPLOY_MISS_GRACE_TICKS && deployResends < DEPLOY_MAX_RESENDS) {
                const missedTick = deployTick;
                deployResends++;
                const resent = await broadcastDeploy();
                deployTick = resent.tick;

                if (resent.ok) {
                    deployResult = resent;
                }

                emit({
                    note: `deploy tx did not land for tick ${missedTick}; resent for tick ${resent.tick} [${deployResends}/${DEPLOY_MAX_RESENDS}]`,
                });
                continue;
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
