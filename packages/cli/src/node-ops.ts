// Shared node lifecycle ops (no UI) used by `qinit node` and `qinit node run`.
import { openSync, closeSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { LiteRpc, cacheRoot, readCurrent, updateCurrent, loadManifest, fetchVerify, verifyPlatformKey, atomicWrite, extractTarGz, debug } from "@qinit/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const scratchDir = () => join(cacheRoot(), "run");
const pidFile = (s: string) => join(s, "node.pid");

const isWin = process.platform === "win32";

// PID of the qinit-managed node, recovered from the on-disk pidfile (survives across qinit invocations).
function trackedPid(scratch: string): number | undefined {
  try { const p = parseInt(readFileSync(pidFile(scratch), "utf8").trim(), 10); return Number.isFinite(p) && p > 0 ? p : undefined; }
  catch { return undefined; }
}
// Liveness without sending a real signal: kill(pid,0) throws ESRCH if gone, EPERM if alive-but-not-ours.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

// Stop ONLY the node qinit started (by tracked PID) + confirm gone. Never a broad pkill/taskkill by
// image name — that also kills unrelated Qubic instances on a multi-node dev box. No pidfile => nothing
// of ours to stop (a foreign node keeps running; a fresh launch then surfaces a clear port-in-use error).
export async function killNode(scratch = scratchDir()): Promise<void> {
  scratch = resolve(scratch);
  const pid = trackedPid(scratch);
  if (pid === undefined) return;
  try { if (isWin) Bun.spawnSync(["taskkill", "/F", "/PID", String(pid)]); else process.kill(pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pid)) { try { rmSync(pidFile(scratch)); } catch {} return; }
    await sleep(250);
  }
}
// Is the qinit-managed node up? Prefer the tracked PID; fall back to a broad image-name probe only when
// there is no pidfile (answers "is any Qubic running", e.g. before a fresh `up`).
export function nodeAlive(scratch = scratchDir()): boolean {
  const pid = trackedPid(resolve(scratch));
  if (pid !== undefined) return pidAlive(pid);
  if (isWin) {
    const r = Bun.spawnSync(["tasklist", "/NH", "/FI", "IMAGENAME eq Qubic.exe"]);
    return new TextDecoder().decode(r.stdout).includes("Qubic.exe");
  }
  return Bun.spawnSync(["pgrep", "-x", "Qubic"]).exitCode === 0;
}

// Download + cache the prebuilt node from the fork's release (manifest-pinned).
export async function fetchNodeBin(ref: string, onProgress?: (recv: number, total: number) => void): Promise<{ bin: string; version: string }> {
  const m = await loadManifest(ref);
  // per-platform node (linux-x64/linux-arm64); fall back to legacy single `node` (= linux-x64).
  const plat = verifyPlatformKey();
  const asset = m.nodes?.[plat] ?? m.node;
  if (!asset) throw new Error(`manifest ${m.version} has no node asset for ${plat} (publish via CI first)`);
  const dir = join(cacheRoot(), m.version, "node");
  const bin = join(dir, isWin ? "Qubic.exe" : "Qubic");
  if (!existsSync(bin)) {
    const buf = await fetchVerify(asset, onProgress);
    mkdirSync(dir, { recursive: true });
    if (asset.url.endsWith(".tar.gz") || asset.url.endsWith(".tgz")) {
      // Windows node ships as a tar.gz bundle: Qubic.exe + its vcpkg applocal DLLs (ffi-8/openssl/c-ares/
      // zlib/brotli), which the exe needs to launch. Extract the whole dir, not a single file.
      await extractTarGz(buf, dir);
      if (!existsSync(bin)) throw new Error(`node archive ${asset.url} did not contain ${isWin ? "Qubic.exe" : "Qubic"}`);
    } else {
      atomicWrite(bin, buf);   // linux/macOS: a bare single binary
      if (!isWin) Bun.spawnSync(["chmod", "+x", bin]);
    }
  }
  updateCurrent({ nodeVersion: m.version, node: bin });
  return { bin, version: m.version };
}
export function cachedNode(): string | undefined { const n = readCurrent()?.node; return n && existsSync(n) ? n : undefined; }

// Resolve the node binary to run: prefer the latest/pinned release (fetchNodeBin no-op-skips the
// download when that version is already cached) and fall back to a cached node only when the manifest
// is unreachable (offline). Fixes the stale-cache bug — callers that checked cachedNode() first would
// silently run a long-cached older version (e.g. v0.0.3) against newer tooling instead of the release.
export async function ensureNode(ref = "latest", onProgress?: (recv: number, total: number) => void): Promise<{ bin: string; version: string; stale: boolean }> {
  try {
    const r = await fetchNodeBin(ref, onProgress);
    return { ...r, stale: false };
  } catch {
    const bin = cachedNode();
    if (bin) return { bin, version: readCurrent()?.nodeVersion ?? "cached", stale: true };
    throw new Error("no node: latest release unreachable and nothing cached (run `qinit node run` online first)");
  }
}

export interface LaunchOpts { bin: string; dir?: string; mode?: string; peers?: string; keep?: boolean; }
// Detached launch (node outlives qinit). Fresh scratch unless keep; never in-tree.
export function launchNode(o: LaunchOpts): { pid: number; scratch: string; log: string } {
  const scratch = resolve(o.dir || scratchDir());
  if (!o.keep) rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const log = join(scratch, "node.log");
  const fd = openSync(log, "a");
  // detached + unref so the node OUTLIVES qinit (notably `qinit node run`/`test --keep`). A non-detached child
  // is killed when the parent process exits on Windows; detached:true gives it its own process group on
  // every OS. windowsHide stops a console window popping up.
  const child = spawn(o.bin, ["--peers", o.peers || "127.0.0.1", "--node-mode", o.mode || "3", "--ticking-delay", "1000"],
    { cwd: scratch, stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
  child.unref();
  closeSync(fd);   // child holds its own dup; don't keep the parent's copy open
  const pid = child.pid ?? 0;
  writeFileSync(pidFile(scratch), String(pid));
  return { pid, scratch, log };
}

// Launch the in-process TS engine as a detached background node (`qinit mode virtualnode`). Re-invokes this
// same qinit — the compiled binary, or `bun index.tsx` in dev — as the hidden `__serve` process bound to the
// RPC port, so every node command then talks to the engine over HTTP just like a real node. Tracked by the
// same pidfile as launchNode, so killNode / nodeAlive / `qinit node stop` work unchanged.
export function launchVirtualNode(o: { dir?: string; rpcBase?: string; keep?: boolean; tickMs?: number; system?: string[] }): { pid: number; scratch: string; log: string } {
  const scratch = resolve(o.dir || scratchDir());
  if (!o.keep) rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const log = join(scratch, "node.log");
  const fd = openSync(log, "a");

  // Self-exec: a compiled bin runs `<bin> __serve …`; in dev, execPath is bun so re-pass the entry script.
  const self = process.execPath;
  const compiled = !/bun(\.exe)?$/i.test(self);
  const rpcBase = o.rpcBase || "http://127.0.0.1:41841";
  const flags = [
    "--rpc", rpcBase,
    ...(o.tickMs !== undefined ? ["--tick-ms", String(o.tickMs)] : []),
    ...(o.system?.length ? ["--system", o.system.join(",")] : []),
  ];
  const argv = compiled ? ["__serve", ...flags] : [Bun.main, "__serve", ...flags];

  const child = spawn(self, argv, { cwd: scratch, stdio: ["ignore", fd, fd], detached: true, windowsHide: true });
  child.unref();
  closeSync(fd);
  const pid = child.pid ?? 0;
  writeFileSync(pidFile(scratch), String(pid));
  return { pid, scratch, log };
}

// Poll RPC until the tick advances (ticking) or the process exits / times out.
export async function waitTicking(rpcBase: string, seconds: number): Promise<{ ticking: boolean; tick: number; exited: boolean }> {
  const rpc = new LiteRpc(rpcBase);
  let t0 = -1, cur = 0;
  for (let i = 0; i < seconds; i++) {
    await sleep(1000);
    if (!nodeAlive()) return { ticking: false, tick: cur, exited: true };
    try {
      const ti: any = await rpc.tickInfo();
      cur = ti.tick ?? ti.currentTick ?? 0;
      if (t0 < 0) t0 = cur;
      if (cur > t0 + 1) return { ticking: true, tick: cur, exited: false };
    } catch {}
  }
  return { ticking: false, tick: cur, exited: false };
}

// Armed contracts via a single registry read (no tick sampling).
export async function nodeContracts(rpcBase: string): Promise<string[]> {
  try {
    const reg: any = await new LiteRpc(rpcBase).dynRegistry();
    return (reg.contracts ?? []).filter((c: any) => c.armed).map((c: any) => `${c.name || c.index}@${c.index}`);
  } catch (e) { debug("nodeContracts: dyn-registry read failed", e); return []; }
}

export interface NodeStatus { up: boolean; ticking: boolean; tick: number; epoch: number; armed: number; slotCount: number; contracts: string[]; }
// Status from the built-in RPC (two tick samples => ticking vs idle).
export async function nodeStatus(rpcBase: string): Promise<NodeStatus> {
  const rpc = new LiteRpc(rpcBase);
  try {
    const t1: any = await rpc.tickInfo();
    await sleep(1200);
    const t2: any = await rpc.tickInfo();
    const a = t1.tick ?? t1.currentTick ?? 0, b = t2.tick ?? t2.currentTick ?? 0;
    const reg: any = await rpc.dynRegistry().catch(() => ({}));
    const armed = (reg.contracts ?? []).filter((c: any) => c.armed);
    return {
      up: true, ticking: b > a, tick: b, epoch: t2.epoch ?? 0,
      armed: armed.length, slotCount: reg.slotCount ?? 0,
      contracts: armed.map((c: any) => `${c.name || c.index}@${c.index}${c.constructed ? "" : " (armed)"}`),
    };
  } catch (e) { debug("nodeStatus: rpc read failed", e); return { up: false, ticking: false, tick: 0, epoch: 0, armed: 0, slotCount: 0, contracts: [] }; }
}
