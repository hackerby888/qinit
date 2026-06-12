// Node lifecycle: killNode/nodeAlive must act on the tracked PID (the on-disk pidfile), never a broad
// image-name pkill/taskkill that also kills unrelated Qubic instances on a dev box. Uses detached
// sleeper processes (own process group, reaped by init -> no test-side zombies) as stand-in nodes.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killNode, nodeAlive } from "../src/node-ops";

const scratch = () => mkdtempSync(join(tmpdir(), "qinit-nodeops-"));
const pidFile = (s: string) => join(s, "node.pid");
// A detached, long-lived process (own group -> not a child of the test runner, so no zombie on death).
const sleeper = (): number => { const c = spawn("bun", ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" }); c.unref(); return c.pid!; };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("killNode stops ONLY the tracked PID, not an unrelated process", async () => {
  const dir = scratch();
  const mine = sleeper();    // the node qinit manages
  const other = sleeper();   // an unrelated instance that must survive
  try {
    writeFileSync(pidFile(dir), String(mine));
    await killNode(dir);
    expect(alive(mine)).toBe(false);          // tracked one killed
    expect(alive(other)).toBe(true);          // bystander untouched (no broad kill)
    expect(existsSync(pidFile(dir))).toBe(false); // pidfile cleared on success
  } finally {
    try { process.kill(other, "SIGKILL"); } catch {}
    try { process.kill(mine, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killNode is a no-op (no throw, no broad kill) when there is no pidfile", async () => {
  const dir = scratch();
  const bystander = sleeper();
  try {
    await killNode(dir);                  // nothing tracked -> must not touch anything
    expect(alive(bystander)).toBe(true);
  } finally {
    try { process.kill(bystander, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeAlive reflects the tracked PID's liveness", async () => {
  const dir = scratch();
  const mine = sleeper();
  try {
    writeFileSync(pidFile(dir), String(mine));
    expect(nodeAlive(dir)).toBe(true);
    process.kill(mine, "SIGKILL");
    for (let i = 0; i < 20 && alive(mine); i++) await sleep(100);
    expect(nodeAlive(dir)).toBe(false);
  } finally {
    try { process.kill(mine, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
