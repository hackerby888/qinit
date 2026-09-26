// a bare simulator runs no system contract, yet the catalog lists all of them: the campaign found `state QX` decoding zero bytes field by field.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineServer } from "@qinit/engine/server";
import { initK12 } from "@qinit/core";

const cli = join(import.meta.dir, "../../src/index.tsx");
// the catalog comes from the core headers; the checked-in snapshot carries contract_def.h and every contract.
const core = process.env.QINIT_CORE ?? resolve(import.meta.dir, "../../../vscode/resources/core-headers");

beforeAll(async () => {
    await initK12();
});

async function boot() {
    const server = new EngineServer();
    const handle = await server.start(0);
    const cwd = mkdtempSync(join(tmpdir(), "qinit-system-not-loaded-"));

    const run = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, cli, ...args, "--rpc", handle.rpcBaseUrl], {
            cwd,
            env: { ...process.env, QINIT_NO_UPDATE: "1", QINIT_CORE: core },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { code: child.exitCode, text: stdout + stderr };
    };
    const stop = () => {
        handle.stop();
        rmSync(cwd, { recursive: true, force: true });
    };

    return { run, stop };
}

test("a system contract the simulator never added is refused by name, not decoded as zeros", async () => {
    const { run, stop } = await boot();
    try {
        const state = await run("state", "QX", "--json");
        expect(state.code).toBe(1);
        expect(state.text).toContain("QX is not running on this simulator — qinit system add QX");
        expect(state.text).not.toContain("short state read");

        const call = await run("call", "--fn", "QX", "Fees");
        expect(call.code).toBe(1);
        expect(call.text).toContain("QX is not running on this simulator — qinit system add QX");

        const struct = await run("state", "QUOTTERY");
        expect(struct.code).toBe(1);
        expect(struct.text).toContain("QUOTTERY is QTRY's state struct — use QTRY");

        const ls = await run("ls", "--json");
        expect(ls.code, ls.text).toBe(0);
        expect(JSON.parse(ls.text).systemLoaded).toBe(false);
    } finally {
        stop();
    }
}, 90_000);
