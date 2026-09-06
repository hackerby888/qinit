import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_TEST_TIMEOUT_MS, removeDirWithRetry, runCli } from "../../../../test-utils/cli";

const canListen = (() => {
    try {
        const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
        probe.stop(true);
        return true;
    } catch {
        return false;
    }
})();

// The command writes into its working directory, so every run gets its own.
const workDir = realpathSync(mkdtempSync(join(tmpdir(), "qinit-state-dump-cli-")));

afterAll(() => {
    removeDirWithRetry(workDir);
});

async function runState(args: string[]) {
    const result = await runCli(["state", ...args], { cwd: workDir });
    return { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
function stateServer(state: Uint8Array) {
    return Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/live/v1/dyn-registry") {
                return Response.json({
                    contracts: [{ index: 29, name: "DumpProbe", armed: true }],
                });
            }
            if (url.pathname === "/live/v1/dev/state-read") {
                const off = Number(url.searchParams.get("off"));
                const len = Math.min(Number(url.searchParams.get("len")), 262144);
                const chunk = state.slice(off, off + len);
                return Response.json({
                    off,
                    len: chunk.length,
                    stateSize: state.length,
                    hex: Buffer.from(chunk).toString("hex"),
                });
            }
            return new Response("not found", { status: 404 });
        },
    });
}

test.skipIf(!canListen)("state --dump --json writes the state and reports the file", async () => {
    const state = new Uint8Array(1024).fill(7);
    const server = stateServer(state);

    try {
        const result = await runState(["DumpProbe", "--dump", "--json", "--rpc", `http://127.0.0.1:${server.port}`]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            ok: true,
            slot: 29,
            name: "DumpProbe",
            path: join(workDir, "state", "DumpProbe_dump.bin"),
            size: 1024,
        });
        expect(new Uint8Array(readFileSync(join(workDir, "state", "DumpProbe_dump.bin")))).toEqual(state);
    } finally {
        server.stop(true);
    }
}, CLI_TEST_TIMEOUT_MS);

// A dump needs neither IDL nor source, so a slot the registry never lists still works.
test.skipIf(!canListen)("state --dump takes a numeric slot and an --out path", async () => {
    const server = stateServer(new Uint8Array(64).fill(3));

    try {
        const result = await runState(["31", "--dump", "--out", "before.bin", "--json", "--rpc", `http://127.0.0.1:${server.port}`]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            ok: true,
            slot: 31,
            path: join(workDir, "before.bin"),
            size: 64,
        });
    } finally {
        server.stop(true);
    }
}, CLI_TEST_TIMEOUT_MS);

test.skipIf(!canListen)("state --dump --json reports a failure and exits nonzero", async () => {
    const server = Bun.serve({
        port: 0,
        fetch() {
            return new Response("broken", { status: 503 });
        },
    });

    try {
        const result = await runState(["29", "--dump", "--json", "--rpc", `http://127.0.0.1:${server.port}`]);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout).ok).toBe(false);
    } finally {
        server.stop(true);
    }
}, CLI_TEST_TIMEOUT_MS);

test("state --out without --dump is an argument error", async () => {
    const result = await runState(["29", "--out", "x.bin"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("--out only applies with --dump");
}, CLI_TEST_TIMEOUT_MS);
