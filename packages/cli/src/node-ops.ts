// Shared node lifecycle ops (no UI) used by `qinit node` and `qinit up`.
import { openSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LiteRpc, cacheRoot, readCurrent, updateCurrent, loadManifest, fetchVerify } from "@qinit/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const scratchDir = () => join(cacheRoot(), "run");
const pidFile = (s: string) => join(s, "node.pid");

// pkill any node + confirm gone (stale instance holds the port/locks).
export async function killNode(): Promise<void> {
  Bun.spawnSync(["pkill", "-x", "Qubic"]);
  for (let i = 0; i < 20; i++) {
    if (Bun.spawnSync(["pgrep", "-x", "Qubic"]).exitCode !== 0) return;
    await sleep(250);
  }
}
export function nodeAlive(): boolean { return Bun.spawnSync(["pgrep", "-x", "Qubic"]).exitCode === 0; }

// Download + cache the prebuilt node from the fork's release (manifest-pinned).
export async function fetchNodeBin(ref: string): Promise<{ bin: string; version: string }> {
  const m = await loadManifest(ref);
  if (!m.node) throw new Error(`manifest ${m.version} has no node asset (publish via CI first)`);
  const dir = join(cacheRoot(), m.version, "node");
  const bin = join(dir, "Qubic");
  if (!existsSync(bin)) {
    const buf = await fetchVerify(m.node);
    mkdirSync(dir, { recursive: true });
    writeFileSync(bin, buf);
    Bun.spawnSync(["chmod", "+x", bin]);
  }
  updateCurrent({ nodeVersion: m.version, node: bin });
  return { bin, version: m.version };
}
export function cachedNode(): string | undefined { const n = readCurrent()?.node; return n && existsSync(n) ? n : undefined; }

export interface LaunchOpts { bin: string; dir?: string; mode?: string; peers?: string; keep?: boolean; }
// Detached launch (node outlives qinit). Fresh scratch unless keep; never in-tree.
export function launchNode(o: LaunchOpts): { pid: number; scratch: string; log: string } {
  const scratch = resolve(o.dir || scratchDir());
  if (!o.keep) rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const log = join(scratch, "node.log");
  const fd = openSync(log, "a");
  const proc = Bun.spawn([o.bin, "--peers", o.peers || "127.0.0.1", "--node-mode", o.mode || "3", "--ticking-delay", "1000"],
    { cwd: scratch, stdin: "ignore", stdout: fd, stderr: fd });
  proc.unref();
  writeFileSync(pidFile(scratch), String(proc.pid));
  return { pid: proc.pid, scratch, log };
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
  } catch { return []; }
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
  } catch { return { up: false, ticking: false, tick: 0, epoch: 0, armed: 0, slotCount: 0, contracts: [] }; }
}
