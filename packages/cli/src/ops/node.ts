import { openSync, closeSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
    DEFAULT_PEER_PORT,
    DEFAULT_RPC_BASE,
    LOOPBACK_HOST,
    LiteRpc,
    cacheRoot,
    readCurrent,
    updateCurrent,
    loadManifest,
    downloadVerifiedAssetToFile,
    releasePlatformKey,
    debug,
    type AssetRef,
    type CurrentPointer,
    type EngineFaultInfo,
    type Manifest,
} from "@qinit/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const defaultNodeScratchDir = () => join(cacheRoot(), "run");
const pidFile = (scratch: string) => join(scratch, "node.pid");
const activeScratchFile = () => join(cacheRoot(), "active-node-scratch");

const isWindows = process.platform === "win32";

export function activeNodeScratchDir(): string {
    try {
        return resolve(readFileSync(activeScratchFile(), "utf8").trim() || defaultNodeScratchDir());
    } catch {
        return resolve(defaultNodeScratchDir());
    }
}

function rememberActiveScratch(scratch: string): void {
    mkdirSync(cacheRoot(), { recursive: true });
    writeFileSync(activeScratchFile(), scratch);
}

// `active-node-scratch` holds exactly one node; this index maps each RPC endpoint to the scratch dir
// serving it, so `node stop --rpc <url>` can address a specific node.
const nodeIndexFile = () => join(cacheRoot(), "node-index.json");

function readNodeIndex(): Record<string, string> {
    try {
        const parsed = JSON.parse(readFileSync(nodeIndexFile(), "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeNodeIndex(index: Record<string, string>): void {
    mkdirSync(cacheRoot(), { recursive: true });
    writeFileSync(nodeIndexFile(), JSON.stringify(index, null, 2) + "\n");
}

function rememberNodeRpc(rpcBaseUrl: string | undefined, scratch: string): void {
    if (!rpcBaseUrl) {
        return;
    }
    writeNodeIndex({ ...readNodeIndex(), [rpcBaseUrl]: scratch });
}

function forgetNodeScratch(scratch: string): void {
    const index = readNodeIndex();
    let changed = false;
    for (const [rpc, dir] of Object.entries(index)) {
        if (resolve(dir) === resolve(scratch)) {
            delete index[rpc];
            changed = true;
        }
    }
    if (changed) {
        writeNodeIndex(index);
    }
}

/** the scratch dir serving this RPC endpoint, or undefined when no node was launched for it here. */
export function scratchForRpc(rpcBaseUrl: string): string | undefined {
    const recorded = readNodeIndex()[rpcBaseUrl];
    return recorded ? resolve(recorded) : undefined;
}

function forgetActiveScratch(scratch: string): void {
    if (activeNodeScratchDir() !== scratch) {
        return;
    }
    try {
        rmSync(activeScratchFile());
    } catch {}
}

// The pidfile lets later Qinit invocations find the detached node.
function trackedPid(scratch: string): number | undefined {
    try {
        const pid = parseInt(readFileSync(pidFile(scratch), "utf8").trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

// Signal 0 checks liveness without stopping the process.
function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === "EPERM";
    }
}

// Never kill by image name: a developer may be running other Qubic nodes.
// Resolves true once the tracked pid is dead; false when nothing is tracked or it outlived the wait.
export async function killNode(scratch = activeNodeScratchDir()): Promise<boolean> {
    const resolvedScratch = resolve(scratch);
    const pid = trackedPid(resolvedScratch);
    if (pid === undefined) {
        return false;
    }

    try {
        if (isWindows) {
            Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)]);
        } else {
            process.kill(pid, "SIGKILL");
        }
    } catch {
        // The process may have exited after the liveness check.
    }

    for (let i = 0; i < 20; i++) {
        if (!pidAlive(pid)) {
            try {
                rmSync(pidFile(resolvedScratch));
            } catch {
                // A concurrent Qinit invocation may already have removed it.
            }
            forgetActiveScratch(resolvedScratch);
            forgetNodeScratch(resolvedScratch);
            return true;
        }
        await sleep(250);
    }
    return false;
}

export function nodeAlive(scratch = activeNodeScratchDir()): boolean {
    const pid = trackedPid(resolve(scratch));
    if (pid !== undefined) {
        return pidAlive(pid);
    }

    if (isWindows) {
        const result = Bun.spawnSync(["tasklist", "/NH", "/FI", "IMAGENAME eq Qubic.exe"]);
        return new TextDecoder().decode(result.stdout).includes("Qubic.exe");
    }

    return Bun.spawnSync(["pgrep", "-x", "Qubic"]).exitCode === 0;
}

export function nodeAssetForPlatform(manifest: Manifest, platform = releasePlatformKey()): AssetRef | undefined {
    const platformAsset = manifest.nodes?.[platform];
    if (platformAsset) {
        return platformAsset;
    }
    return platform === "linux-x64" ? manifest.node : undefined;
}

export async function fetchNodeBinary(
    ref: string,
    onProgress?: (recv: number, total: number) => void,
    loadedManifest?: Manifest,
    options: { updateCurrent?: boolean } = {},
): Promise<{ nodeBinaryPath: string; version: string }> {
    const manifest = loadedManifest ?? (await loadManifest(ref));
    const platform = releasePlatformKey();
    const asset = nodeAssetForPlatform(manifest, platform);
    if (!asset) {
        throw new Error(`manifest ${manifest.version} has no node asset for ${platform} (publish via CI first)`);
    }

    const dir = join(cacheRoot(), manifest.version, "node");
    const nodeBinaryPath = join(dir, isWindows ? "Qubic.exe" : "Qubic");
    if (!existsSync(nodeBinaryPath)) {
        mkdirSync(dir, { recursive: true });
        await downloadVerifiedAssetToFile(asset, nodeBinaryPath, onProgress);
        if (!isWindows) {
            Bun.spawnSync(["chmod", "+x", nodeBinaryPath]);
        }
    }

    if (options.updateCurrent !== false) {
        updateCurrent({ nodeVersion: manifest.version, node: nodeBinaryPath });
    }
    return { nodeBinaryPath, version: manifest.version };
}

export function cachedNode(): string | undefined {
    const node = readCurrent()?.node;
    return node && existsSync(node) ? node : undefined;
}

export function cachedReleaseRef(version?: string): string | undefined {
    return version && !["local", "cached", "unknown"].includes(version) ? version : undefined;
}

// Drift only means something between two managed releases; a local checkout has no version to compare.
export function versionDrift(current: Pick<CurrentPointer, "headersVersion" | "nodeVersion"> | null | undefined): boolean {
    const headers = cachedReleaseRef(current?.headersVersion);
    const node = cachedReleaseRef(current?.nodeVersion);
    return headers !== undefined && node !== undefined && headers !== node;
}

export async function ensureNodeBinary(
    ref?: string,
    onProgress?: (recv: number, total: number) => void,
    options: { updateCurrent?: boolean } = {},
): Promise<{ nodeBinaryPath: string; version: string; cached: boolean }> {
    if (ref === undefined) {
        const current = readCurrent();
        const nodeBinaryPath = cachedNode();
        if (nodeBinaryPath) {
            return {
                nodeBinaryPath,
                version: current?.nodeVersion ?? "cached",
                cached: true,
            };
        }

        if (current?.coreHeaders && existsSync(current.coreHeaders)) {
            if (current.headersVersion === "local") {
                throw new Error("local headers have no matching managed node — pass --node-bin or select a release with --ref");
            }
            const headersRef = cachedReleaseRef(current.headersVersion);
            if (!headersRef) {
                throw new Error("installed headers do not identify a release — run `qinit setup --force` or pass --ref");
            }
            ref = headersRef;
        }
        ref ??= "latest";
    }

    const node = await fetchNodeBinary(ref, onProgress, undefined, options);
    return { ...node, cached: false };
}

export interface LaunchOptions {
    nodeBinary: string;
    scratchDirectory?: string;
    nodeMode?: string;
    peers?: string;
    // core's HTTP/RPC listen port; without it the node takes its own default and cannot run beside one
    // that already holds that port.
    httpPort?: number;
    // recorded so `node stop --rpc <url>` can find this node again.
    rpcBaseUrl?: string;
    preserveScratchContents?: boolean;
}

export function launchNode(options: LaunchOptions): { pid: number; scratch: string; log: string } {
    const scratch = resolve(options.scratchDirectory || defaultNodeScratchDir());
    if (!options.preserveScratchContents) {
        rmSync(scratch, { recursive: true, force: true });
    }

    mkdirSync(scratch, { recursive: true });

    const log = join(scratch, "node.log");
    const logFd = openSync(log, "a");
    const args = ["--peers", options.peers || LOOPBACK_HOST, "--node-mode", options.nodeMode || "3", "--ticking-delay", "1000"];
    if (options.httpPort !== undefined) {
        args.push("--http-port", String(options.httpPort));
    }
    const child = spawn(options.nodeBinary, args, {
        cwd: scratch,
        stdio: ["ignore", logFd, logFd],
        detached: true,
        windowsHide: true,
    });

    child.unref();

    // The child keeps its duplicated descriptor after the parent closes this one.
    closeSync(logFd);

    const pid = child.pid ?? 0;
    writeFileSync(pidFile(scratch), String(pid));
    rememberActiveScratch(scratch);
    rememberNodeRpc(options.rpcBaseUrl, scratch);
    return { pid, scratch, log };
}

export function launchSimulatorNode(options: {
    scratchDirectory?: string;
    rpcBaseUrl?: string;
    peerPort?: number;
    preserveScratchContents?: boolean;
    tickMs?: number;
    historyTicks?: number;
    liteTicking?: boolean;
    system?: string[];
    slotBase?: number;
    slotCount?: number;
    compiler?: "clang" | "typescript";
    coreDirectory?: string;
}): { pid: number; scratch: string; log: string } {
    const scratch = resolve(options.scratchDirectory || defaultNodeScratchDir());
    if (!options.preserveScratchContents) {
        rmSync(scratch, { recursive: true, force: true });
    }

    mkdirSync(scratch, { recursive: true });

    const log = join(scratch, "node.log");
    const logFd = openSync(log, "a");

    const executable = process.execPath;
    const compiled = !/bun(\.exe)?$/i.test(executable);
    const rpcBaseUrl = options.rpcBaseUrl || DEFAULT_RPC_BASE;
    const flags = [
        "--rpc",
        rpcBaseUrl,
        "--peer-port",
        String(options.peerPort ?? DEFAULT_PEER_PORT),
        ...(options.slotBase !== undefined ? ["--slot-base", String(options.slotBase)] : []),
        ...(options.slotCount !== undefined ? ["--slot-count", String(options.slotCount)] : []),
        ...(options.tickMs !== undefined ? ["--tick-ms", String(options.tickMs)] : []),
        ...(options.historyTicks !== undefined ? ["--history-ticks", String(options.historyTicks)] : []),
        ...(options.liteTicking === false ? ["--full-tick"] : []),
        ...(options.system?.length ? ["--system", options.system.join(",")] : []),
        ...(options.compiler ? ["--compiler", options.compiler] : []),
    ];

    // A compiled binary can self-exec; Bun needs the source entry point again.
    const argv = compiled ? ["__serve", ...flags] : [Bun.main, "__serve", ...flags];
    const child = spawn(executable, argv, {
        cwd: scratch,
        stdio: ["ignore", logFd, logFd],
        detached: true,
        windowsHide: true,
        env: options.coreDirectory ? { ...process.env, QINIT_CORE: options.coreDirectory } : process.env,
    });

    child.unref();
    closeSync(logFd);

    const pid = child.pid ?? 0;
    writeFileSync(pidFile(scratch), String(pid));
    rememberActiveScratch(scratch);
    return { pid, scratch, log };
}

// `isAlive` is a seam for the test, which drives a stub RPC with no node process behind it.
export async function waitTicking(
    rpcBaseUrl: string,
    seconds: number,
    isAlive: () => boolean = nodeAlive,
): Promise<{ ticking: boolean; tick: number; exited: boolean }> {
    const rpc = new LiteRpc(rpcBaseUrl);
    let previousTick = -1;
    let currentTick = 0;
    let advances = 0;

    for (let i = 0; i < seconds; i++) {
        await sleep(1000);
        if (!isAlive()) {
            return { ticking: false, tick: currentTick, exited: true };
        }

        try {
            const tickInfo = await rpc.tickInfo();
            currentTick = tickInfo.tick;
            // A node serves RPC before it loads its epoch, so its first jump (0 -> the epoch's initial tick)
            // happens even when the chain never moves again. Only a second advance proves it is ticking.
            if (previousTick >= 0 && currentTick > previousTick) {
                advances++;
                if (advances >= 2) {
                    return { ticking: true, tick: currentTick, exited: false };
                }
            }
            previousTick = currentTick;
        } catch {
            // Keep polling while the node starts its RPC server.
        }
    }

    return { ticking: false, tick: currentTick, exited: false };
}

export async function nodeContracts(rpcBaseUrl: string): Promise<string[]> {
    try {
        const registry = await new LiteRpc(rpcBaseUrl).dynRegistry();
        return (registry.contracts ?? []).filter((contract) => contract.armed).map((contract) => `${contract.name || contract.index}@${contract.index}`);
    } catch (error) {
        debug("nodeContracts: dyn-registry read failed", error);
        return [];
    }
}

export interface NodeStatus {
    up: boolean;
    ticking: boolean;
    /** Set when the node stopped on a contract trap, which reads as "not ticking" without it. */
    fault: EngineFaultInfo | null;
    tick: number;
    epoch: number;
    armed: number;
    slotCount: number;
    contracts: string[];
}

// A reported reserve at or below zero means the node skips the contract's procedures until it is refilled.
export const contractIsDormant = (contract: { feeReserve?: string }) => contract.feeReserve !== undefined && BigInt(contract.feeReserve) <= 0n;

export const contractLabel = (contract: { name?: string; index: number; constructed?: boolean; feeReserve?: string }) =>
    `${contract.name || contract.index}@${contract.index}${!contract.constructed ? " (armed)" : contractIsDormant(contract) ? " (dormant)" : ""}`;

export async function nodeStatus(rpcBaseUrl: string): Promise<NodeStatus> {
    const rpc = new LiteRpc(rpcBaseUrl);
    try {
        const firstTickInfo = await rpc.tickInfo();
        await sleep(1200);
        const secondTickInfo = await rpc.tickInfo();
        const firstTick = firstTickInfo.tick;
        const secondTick = secondTickInfo.tick;
        const registry = await rpc.dynRegistry().catch(() => ({ contracts: [], slotBase: 0, slotCount: 0 }));
        const armedContracts = (registry.contracts ?? []).filter((contract) => contract.armed);

        return {
            up: true,
            ticking: secondTick > firstTick,
            fault: secondTickInfo.fault ?? null,
            tick: secondTick,
            epoch: secondTickInfo.epoch ?? 0,
            armed: armedContracts.length,
            slotCount: registry.slotCount ?? 0,
            contracts: armedContracts.map(contractLabel),
        };
    } catch (error) {
        debug("nodeStatus: rpc read failed", error);
        return {
            up: false,
            ticking: false,
            fault: null,
            tick: 0,
            epoch: 0,
            armed: 0,
            slotCount: 0,
            contracts: [],
        };
    }
}
