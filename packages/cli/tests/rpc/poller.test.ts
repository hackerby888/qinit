// The shared boot-wait poller gates Qinit's live-node CI.
import { test, expect } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
// The poller is a bash script shelling out to curl + jq; skip on hosts missing any of them, since CI runners have all three.
const canPoll = ["bash", "curl", "jq"].every((c) => !!Bun.which(c));

// Every try spawns bash + curl + jq, about a second per round on Windows, so these run past bun's 5 s default — hence the explicit timeout on each test.
const POLL_TIMEOUT_MS = 30_000;

// async Bun.spawn (NOT spawnSync): a sync spawn blocks the event loop, so the in-process Bun.serve could not answer the script's curl.
async function runPoll(url: string, filter: string, tries = "3", nap = "1") {
    const p = Bun.spawn(["bash", "scripts/live-node/poll-node-json.sh", url, filter, tries, nap], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
    });
    const out = (await new Response(p.stdout).text()).trim();
    // The value `exited` resolves to, not `p.exitCode`: a signalled process leaves exitCode null, so a killed bash reads as received-null, not the signal.
    const code = await p.exited;
    return { out, code, signal: p.signalCode };
}

test.skipIf(!canPoll)(
    "poll-node-json.sh echoes the field and exits 0 when present",
    async () => {
        const srv = Bun.serve({
            port: 0,
            fetch: () => new Response(JSON.stringify({ digest: "deadbeef" })),
        });
        try {
            const { out, code, signal } = await runPoll(`http://127.0.0.1:${srv.port}/x`, ".digest // empty");
            expect(out).toBe("deadbeef");
            expect(code, `signal: ${signal}`).toBe(0);
        } finally {
            srv.stop(true);
        }
    },
    POLL_TIMEOUT_MS,
);

test.skipIf(!canPoll)(
    "poll-node-json.sh retries then exits 1 when the value never appears",
    async () => {
        const srv = Bun.serve({ port: 0, fetch: () => new Response("{}") });
        try {
            const { out, code, signal } = await runPoll(`http://127.0.0.1:${srv.port}/x`, ".digest // empty", "2", "1");
            expect(out).toBe("");
            expect(code, `signal: ${signal}`).toBe(1);
        } finally {
            srv.stop(true);
        }
    },
    POLL_TIMEOUT_MS,
);

test.skipIf(!canPoll)(
    "poll-node-json.sh treats 0 as not-ready (so a tick poll waits past tick 0)",
    async () => {
        const srv = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ tick: 0 })) });
        try {
            const { code, signal } = await runPoll(`http://127.0.0.1:${srv.port}/x`, ".tick // 0", "2", "1");
            expect(code, `signal: ${signal}`).toBe(1);
        } finally {
            srv.stop(true);
        }
    },
    POLL_TIMEOUT_MS,
);
