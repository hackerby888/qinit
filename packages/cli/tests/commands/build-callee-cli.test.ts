import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const core = process.env.QINIT_CORE?.trim();
const haveCore = !!core && existsSync(join(core, "src", "qpi", "qpi.h"));
const cli = resolve(import.meta.dir, "../../src/index.tsx");

test.skipIf(!haveCore)(
    "build resolves and auto-slots a local callee while the node is offline",
    async () => {
        const projectRoot = mkdtempSync(join(tmpdir(), "qinit-build-callee-"));
        const contractsDir = join(projectRoot, "contracts");
        const outDir = join(projectRoot, "dist");
        mkdirSync(contractsDir);
        copyFileSync(
            resolve(import.meta.dir, "../../../../fixtures/Counter.h"),
            join(contractsDir, "Counter.h"),
        );
        copyFileSync(
            resolve(import.meta.dir, "../../../../fixtures/Proxy.h"),
            join(contractsDir, "Proxy.h"),
        );

        try {
            const child = Bun.spawn(
                [
                    process.execPath,
                    cli,
                    "build",
                    "contracts/Proxy.h",
                    "--compiler",
                    "typescript",
                    "--core-dir",
                    core!,
                    "--rpc",
                    "http://127.0.0.1:1",
                    "--out",
                    outDir,
                    "--json",
                ],
                {
                    cwd: projectRoot,
                    env: { ...process.env, QINIT_NO_UPDATE: "1" },
                    stdout: "pipe",
                    stderr: "pipe",
                },
            );
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);

            expect(exitCode, stderr).toBe(0);
            const result = JSON.parse(stdout) as {
                ok: boolean;
                artifact: string;
                idl?: { dependencies?: string[] };
            };
            expect(result.ok).toBe(true);
            expect(result.idl?.dependencies).toEqual(["Counter"]);
            expect(existsSync(result.artifact)).toBe(true);
            expect(existsSync(join(outDir, "Counter.wasm"))).toBe(true);
        } finally {
            rmSync(projectRoot, { recursive: true, force: true });
        }
    },
    30_000,
);
