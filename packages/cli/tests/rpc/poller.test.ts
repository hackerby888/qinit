// The shared boot-wait poller (scripts/poll-node-json.sh) gates both qinit's own CI and core-lite's
// qinit-release smoke, so a regression in it is expensive. Exercise it directly against a Bun.serve:
// present -> echo value + exit 0; never-ready -> retry then exit 1; "0" treated as not-ready (tick poll).
// Running under the windows lint-test leg also proves `bash <script>` resolves on the Git-bash runner.
import { test, expect } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
// The poller is a bash script that shells out to curl + jq. Skip on hosts missing any of them (e.g. a
// Windows dev box without Git Bash/jq); CI (Linux runners + the Git-bash windows runner) has all three.
const canPoll = ["bash", "curl", "jq"].every((c) => !!Bun.which(c));

// async Bun.spawn (NOT spawnSync): a sync spawn blocks the event loop, so the in-process Bun.serve
// could not answer the script's curl. Awaiting lets the server respond while bash runs.
async function runPoll(url: string, filter: string, tries = "3", nap = "1") {
  const p = Bun.spawn(["bash", "scripts/poll-node-json.sh", url, filter, tries, nap], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return { out, code: p.exitCode };
}

test.skipIf(!canPoll)("poll-node-json.sh echoes the field and exits 0 when present", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ digest: "deadbeef" })) });
  try {
    const { out, code } = await runPoll(`http://127.0.0.1:${srv.port}/x`, ".digest // empty");
    expect(out).toBe("deadbeef");
    expect(code).toBe(0);
  } finally { srv.stop(true); }
});

test.skipIf(!canPoll)("poll-node-json.sh retries then exits 1 when the value never appears", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("{}") });
  try {
    const { out, code } = await runPoll(`http://127.0.0.1:${srv.port}/x`, ".digest // empty", "2", "1");
    expect(out).toBe("");
    expect(code).toBe(1);
  } finally { srv.stop(true); }
});

test.skipIf(!canPoll)("poll-node-json.sh treats 0 as not-ready (so a tick poll waits past tick 0)", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ tick: 0 })) });
  try {
    const { code } = await runPoll(`http://127.0.0.1:${srv.port}/x`, ".tick // 0", "2", "1");
    expect(code).toBe(1);
  } finally { srv.stop(true); }
});
