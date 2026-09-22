// `qinit clean` used to delete on sight; now it previews until --yes, and refuses a root that is not a qinit cache.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function clean(cache: string, ...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, "clean", ...args, "--json"], {
        cwd: tmpdir(),
        env: { ...process.env, QINIT_CACHE: cache, QINIT_NO_UPDATE: "1", CI: "true" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // ink frames precede the envelope; the JSON is the last line
    return { code: child.exitCode, json: JSON.parse(stdout.trim().split("\n").pop()!) };
}

test("clean previews without --yes and removes with it", async () => {
    const cache = mkdtempSync(join(tmpdir(), "qinit-clean-cli-"));
    try {
        writeFileSync(join(cache, "current.json"), "{}");

        const preview = await clean(cache);
        expect(preview.code).toBe(0);
        expect(preview.json).toMatchObject({ ok: true, dryRun: true, root: cache });
        expect(existsSync(join(cache, "current.json"))).toBe(true);

        const wiped = await clean(cache, "--yes");
        expect(wiped.code).toBe(0);
        expect(wiped.json).toMatchObject({ ok: true, dryRun: false, root: cache });
        expect(existsSync(cache)).toBe(false);
    } finally {
        rmSync(cache, { recursive: true, force: true });
    }
}, 60_000);

test("clean --yes refuses a directory that holds nothing of the cache", async () => {
    const stray = mkdtempSync(join(tmpdir(), "qinit-clean-stray-"));
    try {
        writeFileSync(join(stray, "README.md"), "# not a cache");

        const refused = await clean(stray, "--yes");
        expect(refused.code).toBe(1);
        expect(refused.json.ok).toBe(false);
        expect(refused.json.error).toContain("nothing of the qinit cache is there");
        expect(existsSync(join(stray, "README.md"))).toBe(true);
    } finally {
        rmSync(stray, { recursive: true, force: true });
    }
}, 60_000);
