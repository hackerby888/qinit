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
    },
    CLI_TEST_TIMEOUT_MS,
);
