import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../../src/index.tsx");
const core = resolve(import.meta.dir, "../../../vscode/resources/core-headers");
const workDir = mkdtempSync(join(tmpdir(), "qinit-new-"));

afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
});

test("intercontract scaffold relies on workspace discovery, not config callees", async () => {
    const child = Bun.spawn([process.execPath, cli, "new", "Proxy", "--template", "intercontract", "--core-dir", core, "--plain"], {
        cwd: workDir,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(existsSync(join(workDir, "Proxy", "contracts", "Counter.h"))).toBe(true);
    const config = JSON.parse(readFileSync(join(workDir, "Proxy", "qinit.json"), "utf8"));
    expect(config.callees).toBeUndefined();
});
