// waitTicking is the verdict behind every `qinit node run`. A node serves RPC before it loads its epoch,
// so a node that never ticks still jumps once (0 -> the epoch's initial tick) — and that lone jump used
// to read as progress, which is how a dead core node passed CI for months.
import { test, expect } from "bun:test";
import { waitTicking } from "../../src/ops/node";

// Answers /tick-info with the next reading each time, holding the last one once the script runs out.
function tickServer(readings: number[]) {
  let index = 0;
  return Bun.serve({
    port: 0,
    fetch: () => {
      const tick = readings[Math.min(index++, readings.length - 1)];
      return new Response(JSON.stringify({ tick, epoch: 224 }));
    },
  });
}

test("a node that only jumps to its initial tick is not ticking", async () => {
  const server = tickServer([0, 70550000]);
  try {
    const result = await waitTicking(`http://127.0.0.1:${server.port}`, 4, () => true);
    expect(result.ticking).toBe(false);
    expect(result.exited).toBe(false);
    expect(result.tick).toBe(70550000);
  } finally {
    server.stop(true);
  }
});

test("a node whose tick keeps advancing is ticking", async () => {
  const server = tickServer([0, 70550000, 70550001, 70550002]);
  try {
    const result = await waitTicking(`http://127.0.0.1:${server.port}`, 6, () => true);
    expect(result.ticking).toBe(true);
    expect(result.tick).toBeGreaterThan(70550000);
  } finally {
    server.stop(true);
  }
});

test("a node that dies is reported as exited, not as idle", async () => {
  const server = tickServer([0]);
  try {
    const result = await waitTicking(`http://127.0.0.1:${server.port}`, 4, () => false);
    expect(result.exited).toBe(true);
    expect(result.ticking).toBe(false);
  } finally {
    server.stop(true);
  }
});
