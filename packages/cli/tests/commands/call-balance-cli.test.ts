// A transfer the signer cannot cover is accepted by the node and dropped at tick assembly, so the
// procedure never runs; the call has to refuse it before signing instead of reporting a tx id.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineServer } from "@qinit/engine/server";
import { deriveIdentity, initK12 } from "@qinit/core";
import { loadWasmFixture, loadWasmFixtureIdl } from "../../../../test-utils/wasm-fixtures";
import { saveContractIdl } from "../../src/contracts/idl-file";

const SLOT = 28;
const SEED = "d".repeat(55);
const cli = join(import.meta.dir, "../../src/index.tsx");

beforeAll(async () => {
    await initK12();
});

test("a --amount above the signer's balance is refused before signing; one within it is sent", async () => {
    const server = new EngineServer();
    server.engine.deploy(SLOT, await loadWasmFixture("Counter"), "Counter");
    server.engine.fund((await deriveIdentity(SEED)).identity, 50n);
    const handle = await server.start(0);
    const cwd = mkdtempSync(join(tmpdir(), "qinit-call-balance-"));
    saveContractIdl(SLOT, await loadWasmFixtureIdl("Counter"), join(cwd, "qinit.idl.json"));
    const run = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, cli, "call", "--proc", "Counter", "Inc", "--seed", SEED, ...args, "--json", "--rpc", handle.rpcBaseUrl], {
            cwd,
            env: { ...process.env, QINIT_NO_UPDATE: "1" },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { code: child.exitCode, envelope: JSON.parse(stdout) };
    };

    try {
        const refused = await run("--amount", "100");
        expect(refused.code).toBe(1);
        expect(refused.envelope.ok).toBe(false);
        expect(refused.envelope.tx).toBeNull();
        expect(refused.envelope.error).toContain("holds 50 qu, below the 100 qu --amount");

        const sent = await run("--amount", "7");
        expect(sent.code, JSON.stringify(sent.envelope)).toBe(0);
        expect(sent.envelope.ok).toBe(true);
        expect(sent.envelope.tx).toBeTruthy();
    } finally {
        handle.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);
