// a callee writes its own slot, so its state diff belongs in the caller's trace; until now only a printing or trapped callee got a mention.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineServer } from "@qinit/engine/server";
import { initK12 } from "@qinit/core";
import { loadWasmFixture, loadWasmFixtureIdl } from "../../../../test-utils/wasm-fixtures";
import { saveContractIdl } from "../../src/contracts/idl-file";

const COUNTER_SLOT = 28;
const PROXY_SLOT = 29;
const cli = join(import.meta.dir, "../../src/index.tsx");

beforeAll(async () => {
    await initK12();
});

async function boot() {
    const server = new EngineServer();
    server.engine.deploy(COUNTER_SLOT, await loadWasmFixture("Counter"), "Counter");
    server.engine.deploy(PROXY_SLOT, await loadWasmFixture("Proxy"), "Proxy");
    const handle = await server.start(0);
    const cwd = mkdtempSync(join(tmpdir(), "qinit-call-callee-"));
    const idlPath = join(cwd, "qinit.idl.json");
    saveContractIdl(COUNTER_SLOT, await loadWasmFixtureIdl("Counter"), idlPath);
    saveContractIdl(PROXY_SLOT, await loadWasmFixtureIdl("Proxy"), idlPath);

    const run = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, cli, "call", ...args, "--rpc", handle.rpcBaseUrl], {
            cwd,
            env: { ...process.env, QINIT_NO_UPDATE: "1", CI: "true" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { code: child.exitCode, stdout, stderr };
    };
    const stop = () => {
        handle.stop();
        rmSync(cwd, { recursive: true, force: true });
    };

    return { run, stop };
}

test("a traced call shows the callee's frame with the diff of the callee's own state", async () => {
    const { run, stop } = await boot();
    try {
        const human = await run("--proc", String(PROXY_SLOT), "BumpCounter", "--trace");
        expect(human.code, human.stdout).toBe(0);
        const proxyAt = human.stdout.indexOf("Proxy proc#1 (BumpCounter)");
        const counterAt = human.stdout.indexOf("Counter proc#1 (Inc)");
        expect(proxyAt).toBeGreaterThan(-1);
        expect(counterAt).toBeGreaterThan(proxyAt);
        expect(human.stdout.slice(counterAt)).toMatch(/counter\s+0 → 1/);

        // ink frames precede the envelope; the JSON is the last line.
        const json = await run("--proc", String(PROXY_SLOT), "BumpCounter", "--trace", "--json");
        expect(json.code, json.stdout).toBe(0);
        const envelope = JSON.parse(json.stdout.trim().split("\n").pop()!);
        expect(envelope.state).toEqual([]);
        expect(envelope.calls[0].name).toBe("invokeProcedure");
        expect(envelope.callees).toHaveLength(1);
        expect(envelope.callees[0]).toMatchObject({ contract: "Counter", slot: COUNTER_SLOT, entry: "proc#1 (Inc)", kind: "procedure", depth: 0, ok: true });
        expect(envelope.callees[0].state).toEqual([{ label: "counter", detail: "counter", text: "1 → 2", internal: false, before: "1", after: "2" }]);
    } finally {
        stop();
    }
}, 90_000);
