// An entry number the node never registered, and an --out that disagrees with the IDL, both used to pass
// silently: the fn returned zeros, the proc broadcast a tx that no trace ever showed.
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

async function boot() {
    const server = new EngineServer();
    server.engine.deploy(SLOT, await loadWasmFixture("Counter"), "Counter");
    const handle = await server.start(0);
    const cwd = mkdtempSync(join(tmpdir(), "qinit-call-entry-"));
    saveContractIdl(SLOT, await loadWasmFixtureIdl("Counter"), join(cwd, "qinit.idl.json"));

    const run = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, cli, "call", ...args, "--rpc", handle.rpcBaseUrl], {
            cwd,
            env: { ...process.env, QINIT_NO_UPDATE: "1" },
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

test("an unregistered fn number fails, an unregistered proc number warns and still sends", async () => {
    const { run, stop } = await boot();
    try {
        const fn = await run("--fn", String(SLOT), "99");
        expect(fn.code).toBe(1);
        expect(fn.stdout).toContain("no fn 99 on contract 28 (registered: 1)");

        const proc = await run("--proc", String(SLOT), "9", "--no-settle");
        expect(proc.code, proc.stdout).toBe(0);
        expect(proc.stdout).toContain("no proc 9 on contract 28 (registered: 1) — sending the tx anyway");
        expect(proc.stdout).toContain("tx ");
    } finally {
        stop();
    }
});

test("an --out that disagrees with the IDL warns but still prints, and one wider than the answer names both sizes", async () => {
    const { run, stop } = await boot();
    try {
        const narrow = await run("--fn", String(SLOT), "Get", "--out", "uint32");
        expect(narrow.code, narrow.stdout).toBe(0);
        expect(narrow.stdout).toContain("--out uint32 reads 4 bytes; Counter.Get returns { uint64 } (8 bytes)");
        expect(narrow.stdout).toMatch(/out\s+0/);

        const wide = await run("--fn", String(SLOT), "Get", "--out", "id");
        expect(wide.code).toBe(1);
        expect(wide.stdout).toContain("id reads 32 bytes, only 8 returned");
    } finally {
        stop();
    }
});
