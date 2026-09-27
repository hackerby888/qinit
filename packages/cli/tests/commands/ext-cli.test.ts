import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, "ext", ...args, "--json"], {
        env: { ...process.env, QINIT_NO_UPDATE: "1" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code: child.exitCode, envelope: JSON.parse(stdout) };
}

// the stub is a shell script, which windows does not start as a program.
test.skipIf(process.platform === "win32")(
    "a local package is handed to the editor as it is",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "qinit-ext-"));
        const editor = join(directory, "editor");
        const vsix = join(directory, "local.vsix");
        writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "args.txt")}"\n`);
        chmodSync(editor, 0o755);
        writeFileSync(vsix, "package");

        try {
            const installed = await run("install", "--editor", editor, "--vsix", vsix);

            expect(installed.code).toBe(0);
            expect(installed.envelope).toEqual({ ok: true, editor, source: vsix, error: null });
            expect(readFileSync(join(directory, "args.txt"), "utf8").trim().split("\n")).toEqual(["--install-extension", vsix]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    },
    30_000,
);

test("a package that is not there fails with the reason in the document", async () => {
    const missing = join(tmpdir(), "qinit-ext-missing", "none.vsix");

    const refused = await run("install", "--editor", "some-editor", "--vsix", missing);

    expect(refused.code).toBe(1);
    expect(refused.envelope).toEqual({ ok: false, path: missing, error: "vsix not found" });
}, 30_000);
