import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { initK12 } from "../src/k12";
import { VirtualNode } from "../src/transport";
import { EngineServer } from "../src/server";

const QLOGGING = process.env.QLOGGING ?? "/home/kali/Projects/qlogging/build-codex/qlogging";

test.skipIf(!existsSync(QLOGGING))("unmodified qlogging fetches VirtualNode contract logs", async () => {
  await initK12();
  const engine = new VirtualNode();
  const server = new EngineServer(engine);
  const handle = await server.start(0, 1000, 0);
  const port = handle.peerPort!;

  try {
    engine.advanceTick(1);
    const tick = engine.sim.tickN;
    const message = Uint8Array.of(0, 0, 0, 0, 9, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0);
    engine.logger.begin(tick, 0);
    engine.logger.log(28, 6, message, engine.sim.epochN);
    engine.logger.end();
    engine.logger.finalizeTick(tick);

    const proc = Bun.spawn([QLOGGING, "127.0.0.1", String(port), "0", "0", "0", "0", String(tick), "-single"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(), 6000);
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    clearTimeout(killer);
    expect(exit, error || output).toBe(0);
    expect(output).toContain("Tx #0");
    expect(output).toContain("FromId");
    expect(output).toContain("Contract ID #28 INFO");
    expect(output).not.toContain("Failed to get logging content");
  } finally {
    handle.stop();
  }
}, 15_000);
