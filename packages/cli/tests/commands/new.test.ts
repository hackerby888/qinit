import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_TEST_TIMEOUT_MS, removeDirWithRetry, runCli } from "../../../../test-utils/cli";

const core = resolve(import.meta.dir, "../../../vscode/resources/core-headers");
const workDir = mkdtempSync(join(tmpdir(), "qinit-new-"));

afterAll(() => {
    removeDirWithRetry(workDir);
});

test(
    "intercontract scaffold relies on workspace discovery, not config callees",
    async () => {
        const result = await runCli(["new", "Proxy", "--template", "intercontract", "--core-dir", core, "--plain"], { cwd: workDir });

        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(existsSync(join(workDir, "Proxy", "contracts", "Counter.h"))).toBe(true);
        const config = JSON.parse(readFileSync(join(workDir, "Proxy", "qinit.json"), "utf8"));
        expect(config.callees).toBeUndefined();

        // editor typing for the spec: package.json + tsconfig.json; the install itself stays off under QINIT_NO_UPDATE
        expect(JSON.parse(readFileSync(join(workDir, "Proxy", "package.json"), "utf8")).devDependencies).toEqual({ "@types/bun": "latest" });
        expect(existsSync(join(workDir, "Proxy", "tsconfig.json"))).toBe(true);
        expect(existsSync(join(workDir, "Proxy", "node_modules"))).toBe(false);
        expect(readFileSync(join(workDir, "Proxy", ".gitignore"), "utf8")).toContain("node_modules/\n");
    },
    CLI_TEST_TIMEOUT_MS,
);

// the struct is the deploy name, so a project named past the wire limit could never build.
test(
    "a project name too long to deploy is refused before anything is written",
    async () => {
        const name = "A".repeat(32);
        const result = await runCli(["new", name, "--core-dir", core, "--plain"], { cwd: workDir });

        expect(result.code).toBe(1);
        expect(result.stdout + result.stderr).toContain("is 32 characters");
        expect(existsSync(join(workDir, name))).toBe(false);
    },
    CLI_TEST_TIMEOUT_MS,
);
