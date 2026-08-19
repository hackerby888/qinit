import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function runInfo() {
    // An unroutable RPC keeps the node probe from reaching anything a developer happens to be running.
    const child = Bun.spawn([process.execPath, cli, "info", "--json", "--rpc", "http://127.0.0.1:1"], { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code: child.exitCode, setup: JSON.parse(stdout.trim()) };
}

test("info --json reports the setup as one object, with no node running", async () => {
    const { code, setup } = await runInfo();

    expect(code).toBe(0);
    expect(Object.keys(setup).sort()).toEqual(["compiler", "core", "qinit", "runtime"]);

    expect(setup.qinit.version).toMatch(/^\d+\.\d+\.\d+/);
    // The compiler protocol is what a node checks a deployed artifact against, so it has to be a number.
    expect(typeof setup.compiler.protocolVersion).toBe("number");
    expect(setup.compiler.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(setup.compiler.coreCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(["clang", "typescript", "clang (default)"]).toContain(setup.compiler.backend);
    expect(["core", "simulator", "core (default)"]).toContain(setup.runtime.runtime);

    // Nothing is listening on port 1, so the probe has to degrade rather than hang or throw.
    expect(setup.runtime.node).toBe("not reachable");
});
