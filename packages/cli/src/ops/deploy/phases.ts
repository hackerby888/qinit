// Self-contained deploy phases, each answering with its product or the DeployResult the caller should
// return — so deployContract stays a sequence of awaits.
import { readFileSync } from "node:fs";
import { DEFAULT_FUNDED_SEED, LiteRpc, readCurrent, autoUpdateVerifyTool } from "@qinit/core";
import { systemNames } from "@qinit/build";
import { savedSeed, resolveCoreDir } from "../../config";
import { tickFailureMessage, type DeploymentEvent } from "./steps";
import { activeUploadError } from "./upload";
import { describeFault, readFault } from "../fault";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Emit = (event: DeploymentEvent) => void;

export interface PreflightOptions {
    name: string;
    core: string;
    artifact?: unknown;
}

export async function runPreflightChecks(rpc: LiteRpc, options: PreflightOptions, emit: Emit): Promise<{ error: string } | null> {
    // Reject a competing upload before doing build or network work.
    try {
        const upload = await rpc.dynUpload();
        if (upload.active) {
            const error = activeUploadError(upload);
            emit({ step: "upload", state: "fail", detail: error });
            return { error };
        }
    } catch {
        // Older nodes do not expose dyn-upload; the normal reachability check remains authoritative.
    }

    try {
        if (systemNames(resolveCoreDir(options.core)).has(options.name.toLowerCase())) {
            emit({ step: "build", state: "fail", detail: `'${options.name}' is a system contract name` });
            return { error: `'${options.name}' is a reserved system contract name — pick another` };
        }
    } catch {
        // The build step reports a missing core snapshot with more context.
    }

    const pin = readCurrent();
    if (pin?.headersVersion && pin?.nodeVersion && pin.headersVersion !== pin.nodeVersion) {
        emit({ note: `⚠ version drift: headers ${pin.headersVersion} ≠ node ${pin.nodeVersion} — run 'qinit setup'` });
    }

    if (!options.artifact) {
        const verifyUpdate = await autoUpdateVerifyTool();
        if (verifyUpdate.action === "updated" || verifyUpdate.action === "installed") {
            emit({ note: `↻ contractverify ${verifyUpdate.action} → ${verifyUpdate.version}` });
        }
    }

    return null;
}

// Waits until the node has advanced past its starting tick, so the deploy is not racing a stalled chain.
export async function waitForTickReadiness(rpc: LiteRpc, rpcBaseUrl: string, emit: Emit): Promise<{ ok: true; tick: number } | { ok: false; error: string }> {
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
            // A halted node answers with a frozen tick; waiting out the margin would only hide the halt.
            const fault = await readFault(rpc).catch(() => null);
            if (fault) {
                const halted = await describeFault(rpc, fault);
                emit({ step: "tick", state: "fail", detail: halted });
                return { ok: false, error: halted };
            }
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
        return { ok: false, error: tickFailureMessage(reached, rpcBaseUrl) };
    }

    emit({ step: "tick", state: "ok", detail: `tick ${currentTick}` });
    return { ok: true, tick: currentTick };
}

export async function resolveSigningSeed(rpc: LiteRpc, explicitSeed: string | undefined, emit: Emit): Promise<string> {
    if (explicitSeed) {
        return explicitSeed;
    }

    const saved = savedSeed();
    if (saved) {
        emit({ note: "using saved seed (qinit seed)" });
        return saved;
    }

    const funded = await rpc.fundedSeed();
    if (funded) {
        emit({ note: "using node funded seed" });
        return funded;
    }

    return DEFAULT_FUNDED_SEED;
}

// Upload spends a transaction per tick, so a crawling chain fails slowly — only worth measuring on a node we
// cannot drive ourselves.
export async function assertChainFastEnough(
    rpc: LiteRpc,
    currentTick: number,
    readTick: () => Promise<number>,
    emit: Emit,
): Promise<{ error: string; detail: string } | null> {
    const driveable = (await rpc.hurryToTick(currentTick + 3)) >= currentTick + 3;
    if (driveable) {
        return null;
    }

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

    if (ticksAdvanced >= 2) {
        return null;
    }

    const secondsPerTick = ticksAdvanced > 0 ? Math.round((Date.now() - startedAt) / 1000 / ticksAdvanced) : Infinity;
    const speed = secondsPerTick === Infinity ? ">30" : String(secondsPerTick);
    emit({ step: "upload", state: "fail", detail: `chain too slow (~${speed}s/tick)` });

    return {
        detail: `chain too slow (~${speed}s/tick)`,
        error: `node ticking far too slowly (~${speed}s/tick) to deploy within budget — aborting before upload (under-provisioned runner?)`,
    };
}

export interface SimulatorDeployRequest {
    rpc: LiteRpc;
    slot: number;
    wasm: Uint8Array;
    hash: string;
    name: string;
    contractPath: string;
    saveIdl: () => void;
    emit: Emit;
}

// The simulator deploys over a direct route instead of the chunked on-chain protocol, so upload and deploy
// complete together and there is nothing to confirm.
export async function deployToSimulator(request: SimulatorDeployRequest): Promise<{ ok: boolean; error?: string }> {
    const { rpc, slot, wasm, hash, emit } = request;

    let directDeployment: Awaited<ReturnType<typeof rpc.directDeploy>>;
    try {
        directDeployment = await rpc.directDeploy(slot, wasm, request.name, "dynamic");
    } catch (error) {
        // A MIGRATE or INITIALIZE that trapped halts the simulator inside this very request.
        const fault = await readFault(rpc).catch(() => null);
        if (fault) {
            return { ok: false, error: await describeFault(rpc, fault) };
        }
        throw error;
    }
    if (!directDeployment) {
        return { ok: false, error: "simulator does not expose direct deployment; upgrade the Qinit simulator" };
    }

    emit({ step: "upload", state: "ok", detail: "direct (simulator)" });
    emit({ step: "deploy", state: "ok", detail: `slot ${slot}` });

    try {
        await rpc.putContractSource(slot, readFileSync(request.contractPath, "utf8"));
    } catch {
        // Source metadata is optional for a successful deployment.
    }

    request.saveIdl();
    emit({ step: "confirm", state: "ok", detail: `ready · ${hash}` });
    return { ok: true };
}
