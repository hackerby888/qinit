// A dormant contract takes a transaction, refunds it and runs nothing, which used to come back as ok + tx id.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineServer } from "@qinit/engine/server";
import { initK12 } from "@qinit/core";
import { loadWasmFixture, loadWasmFixtureIdl } from "../../../../test-utils/wasm-fixtures";
import { saveContractIdl } from "../../src/contracts/idl-file";

const SLOT = 28;
const cli = join(import.meta.dir, "../../src/index.tsx");

beforeAll(async () => {
    await initK12();
});

test("a procedure on a dormant contract fails before sending, a function still answers", async () => {
    const server = new EngineServer();
    server.engine.deploy(SLOT, await loadWasmFixture("Counter"), "Counter");
    const handle = await server.start(0);
    const cwd = mkdtempSync(join(tmpdir(), "qinit-call-dormant-"));
    saveContractIdl(SLOT, await loadWasmFixtureIdl("Counter"), join(cwd, "qinit.idl.json"));
    const run = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, cli, "call", ...args, "--rpc", handle.rpcBaseUrl], {
            cwd,
            env: { ...process.env, QINIT_NO_UPDATE: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { code: child.exitCode, stdout };
    };

    try {
        server.engine.setContractFeeReserve(SLOT, 0n);

        const proc = await run("--proc", "Counter", "Inc", "--json");
        expect(proc.code, proc.stdout).toBe(1);
        const envelope = JSON.parse(proc.stdout);
        expect(envelope.ok).toBe(false);
        expect(envelope.tx).toBeNull();
        expect(envelope.error).toContain("Counter@28 is dormant: fee reserve 0 qu");

        const fn = await run("--fn", "Counter", "Get", "--json");
        expect(fn.code, fn.stdout).toBe(0);
    } finally {
        handle.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);
