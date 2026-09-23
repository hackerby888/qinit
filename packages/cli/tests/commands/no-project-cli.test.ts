// outside a project every contract command used to fail its own way: a raw ENOENT for a repo fixture, or `contracts/.h not found`.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function run(cwd: string, ...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
        cwd,
        env: { ...process.env, QINIT_NO_UPDATE: "1", CI: "true" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // ink frames precede the envelope; the JSON is the last line
    return { code: child.exitCode, stdout, json: JSON.parse(stdout.trim().split("\n").pop()!) };
}

test("build, test, gtest and deploy outside a project say so and name the fix", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "qinit-no-project-"));
    try {
        for (const command of ["build", "test", "gtest", "deploy"]) {
            const result = await run(cwd, command);
            expect(result.code, command).toBe(1);
            expect(result.stdout, command).toContain("not in a qinit project");
            expect(result.stdout, command).toContain(`qinit ${command} <file.h>`);
            expect(result.stdout, command).not.toContain("ENOENT");
            expect(result.stdout, command).not.toContain("contracts/.h");
            expect(result.json.ok, command).toBe(false);
        }
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
}, 120_000);
