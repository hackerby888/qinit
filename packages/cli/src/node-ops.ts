import {
  openSync,
  closeSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  LiteRpc,
  cacheRoot,
  readCurrent,
  updateCurrent,
  loadManifest,
  fetchVerify,
  verifyPlatformKey,
  atomicWrite,
  extractTarGz,
  debug,
  type AssetRef,
  type Manifest,
} from "@qinit/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const scratchDir = () => join(cacheRoot(), "run");
const pidFile = (scratch: string) => join(scratch, "node.pid");

const isWindows = process.platform === "win32";

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
export async function killNode(scratch = scratchDir()): Promise<void> {
  const resolvedScratch = resolve(scratch);
  const pid = trackedPid(resolvedScratch);
  if (pid === undefined) {
    return;
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
      return;
    }
    await sleep(250);
  }
}

export function nodeAlive(scratch = scratchDir()): boolean {
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

export function nodeAssetForPlatform(
  manifest: Manifest,
  platform = verifyPlatformKey(),
): AssetRef | undefined {
  const platformAsset = manifest.nodes?.[platform];
  if (platformAsset) {
    return platformAsset;
  }
  return platform === "linux-x64" ? manifest.node : undefined;
}

export async function fetchNodeBin(
  ref: string,
  onProgress?: (recv: number, total: number) => void,
  loadedManifest?: Manifest,
): Promise<{ bin: string; version: string }> {
  const manifest = loadedManifest ?? await loadManifest(ref);
  const platform = verifyPlatformKey();
  const asset = nodeAssetForPlatform(manifest, platform);
  if (!asset) {
    throw new Error(
      `manifest ${manifest.version} has no node asset for ${platform} (publish via CI first)`,
    );
  }

  const dir = join(cacheRoot(), manifest.version, "node");
  const bin = join(dir, isWindows ? "Qubic.exe" : "Qubic");
  if (!existsSync(bin)) {
    const archive = await fetchVerify(asset, onProgress);
    mkdirSync(dir, { recursive: true });

    if (asset.url.endsWith(".tar.gz") || asset.url.endsWith(".tgz")) {
      // Windows needs the bundled DLLs beside Qubic.exe.
      await extractTarGz(archive, dir);
      if (!existsSync(bin)) {
        throw new Error(
          `node archive ${asset.url} did not contain ${isWindows ? "Qubic.exe" : "Qubic"}`,
        );
      }
    } else {
      atomicWrite(bin, archive);
      if (!isWindows) {
        Bun.spawnSync(["chmod", "+x", bin]);
      }
    }
  }

  updateCurrent({ nodeVersion: manifest.version, node: bin });
  return { bin, version: manifest.version };
}

export function cachedNode(): string | undefined {
  const node = readCurrent()?.node;
  return node && existsSync(node) ? node : undefined;
}

export async function ensureNode(
  ref = "latest",
  onProgress?: (recv: number, total: number) => void,
): Promise<{ bin: string; version: string; stale: boolean }> {
  try {
    const node = await fetchNodeBin(ref, onProgress);
    return { ...node, stale: false };
  } catch {
    const bin = cachedNode();
    if (bin) {
      return {
        bin,
        version: readCurrent()?.nodeVersion ?? "cached",
        stale: true,
      };
    }

    throw new Error(
      "no node: latest release unreachable and nothing cached (run `qinit node run` online first)",
    );
  }
}

export interface LaunchOpts {
  bin: string;
  dir?: string;
  mode?: string;
  peers?: string;
  keep?: boolean;
}

export function launchNode(
  options: LaunchOpts,
): { pid: number; scratch: string; log: string } {
  const scratch = resolve(options.dir || scratchDir());
  if (!options.keep) {
    rmSync(scratch, { recursive: true, force: true });
  }

  mkdirSync(scratch, { recursive: true });

  const log = join(scratch, "node.log");
  const logFd = openSync(log, "a");
  const args = [
    "--peers",
    options.peers || "127.0.0.1",
    "--node-mode",
    options.mode || "3",
    "--ticking-delay",
    "1000",
  ];
  const child = spawn(options.bin, args, {
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
  return { pid, scratch, log };
}

export function launchVirtualNode(options: {
  dir?: string;
  rpcBase?: string;
  peerPort?: number;
  keep?: boolean;
  tickMs?: number;
  system?: string[];
  slotBase?: number;
  slotCount?: number;
}): { pid: number; scratch: string; log: string } {
  const scratch = resolve(options.dir || scratchDir());
  if (!options.keep) {
    rmSync(scratch, { recursive: true, force: true });
  }

  mkdirSync(scratch, { recursive: true });

  const log = join(scratch, "node.log");
  const logFd = openSync(log, "a");

  const executable = process.execPath;
  const compiled = !/bun(\.exe)?$/i.test(executable);
  const rpcBase = options.rpcBase || "http://127.0.0.1:41841";
  const flags = [
    "--rpc",
    rpcBase,
    "--peer-port",
    String(options.peerPort ?? 21841),
    ...(options.slotBase !== undefined
      ? ["--slot-base", String(options.slotBase)]
      : []),
    ...(options.slotCount !== undefined
      ? ["--slot-count", String(options.slotCount)]
      : []),
    ...(options.tickMs !== undefined
      ? ["--tick-ms", String(options.tickMs)]
      : []),
    ...(options.system?.length
      ? ["--system", options.system.join(",")]
      : []),
  ];

  // A compiled binary can self-exec; Bun needs the source entry point again.
  const argv = compiled
    ? ["__serve", ...flags]
    : [Bun.main, "__serve", ...flags];
  const child = spawn(executable, argv, {
    cwd: scratch,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    windowsHide: true,
  });

  child.unref();
  closeSync(logFd);

  const pid = child.pid ?? 0;
  writeFileSync(pidFile(scratch), String(pid));
  return { pid, scratch, log };
}

export async function waitTicking(
  rpcBase: string,
  seconds: number,
): Promise<{ ticking: boolean; tick: number; exited: boolean }> {
  const rpc = new LiteRpc(rpcBase);
  let initialTick = -1;
  let currentTick = 0;

  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    if (!nodeAlive()) {
      return { ticking: false, tick: currentTick, exited: true };
    }

    try {
      const tickInfo: any = await rpc.tickInfo();
      currentTick = tickInfo.tick ?? tickInfo.currentTick ?? 0;
      if (initialTick < 0) {
        initialTick = currentTick;
      }
      if (currentTick > initialTick + 1) {
        return { ticking: true, tick: currentTick, exited: false };
      }
    } catch {
      // Keep polling while the node starts its RPC server.
    }
  }

  return { ticking: false, tick: currentTick, exited: false };
}

export async function nodeContracts(rpcBase: string): Promise<string[]> {
  try {
    const registry: any = await new LiteRpc(rpcBase).dynRegistry();
    return (registry.contracts ?? [])
      .filter((contract: any) => contract.armed)
      .map((contract: any) => `${contract.name || contract.index}@${contract.index}`);
  } catch (error) {
    debug("nodeContracts: dyn-registry read failed", error);
    return [];
  }
}

export interface NodeStatus {
  up: boolean;
  ticking: boolean;
  tick: number;
  epoch: number;
  armed: number;
  slotCount: number;
  contracts: string[];
}

export async function nodeStatus(rpcBase: string): Promise<NodeStatus> {
  const rpc = new LiteRpc(rpcBase);
  try {
    const firstTickInfo: any = await rpc.tickInfo();
    await sleep(1200);
    const secondTickInfo: any = await rpc.tickInfo();
    const firstTick = firstTickInfo.tick ?? firstTickInfo.currentTick ?? 0;
    const secondTick = secondTickInfo.tick ?? secondTickInfo.currentTick ?? 0;
    const registry: any = await rpc.dynRegistry().catch(() => ({}));
    const armedContracts = (registry.contracts ?? []).filter(
      (contract: any) => contract.armed,
    );

    return {
      up: true,
      ticking: secondTick > firstTick,
      tick: secondTick,
      epoch: secondTickInfo.epoch ?? 0,
      armed: armedContracts.length,
      slotCount: registry.slotCount ?? 0,
      contracts: armedContracts.map(
        (contract: any) =>
          `${contract.name || contract.index}@${contract.index}${
            contract.constructed ? "" : " (armed)"
          }`,
      ),
    };
  } catch (error) {
    debug("nodeStatus: rpc read failed", error);
    return {
      up: false,
      ticking: false,
      tick: 0,
      epoch: 0,
      armed: 0,
      slotCount: 0,
      contracts: [],
    };
  }
}
