import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");
const canListen = (() => {
  try {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
})();

async function runState(port: number, target: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "state",
      target,
      "--digest",
      "--json",
      "--rpc",
      `http://127.0.0.1:${port}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code: child.exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

test.skipIf(!canListen)("state --digest --json emits the canonical success object", async () => {
  const digest = "ef".repeat(32);
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/live/v1/dyn-registry") {
        return Response.json({
          contracts: [{ index: 29, name: "DigestProbe", armed: true }],
        });
      }
      if (path === "/live/v1/dev/contract-digest") {
        return Response.json({ slot: 29, stateSize: 96, digest });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const result = await runState(server.port!, "DigestProbe");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      slot: 29,
      stateSize: 96,
      digest,
    });
  } finally {
    server.stop(true);
  }
});

test.skipIf(!canListen)(
  "state --digest --json emits an error object and exits nonzero on RPC failure",
  async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("broken", { status: 503 });
      },
    });

    try {
      const result = await runState(server.port!, "29");
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: "RPC GET /live/v1/dev/contract-digest?slot=29 → HTTP 503",
      });
    } finally {
      server.stop(true);
    }
  },
);
