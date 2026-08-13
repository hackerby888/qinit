import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadSourceConfig, synchronizedSourceFiles, syncSources } from "./sync-sources";

const repositoryRoot = resolve(import.meta.dir, "../..");
const temporaryRoots: string[] = [];

function copySources(): string {
    const root = mkdtempSync(resolve(tmpdir(), "qinit-sources-"));
    temporaryRoots.push(root);
    for (const relativePath of [
        "config/repositories.json",
        "config/toolchains.json",
        "bun.lock",
        ...synchronizedSourceFiles,
    ]) {
        const target = resolve(root, relativePath);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(resolve(repositoryRoot, relativePath), target);
    }
    return root;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("source configuration sync", () => {
    test("detects drift, updates once, and is idempotent", () => {
        const root = copySources();
        expect(syncSources(root, true)).toEqual([]);

        const repositoriesPath = resolve(root, "config/repositories.json");
        const repositories = JSON.parse(readFileSync(repositoriesPath, "utf8"));
        repositories.qinit.repository = "new-org/qinit";
        repositories.qinit.defaultBranch = "develop";
        writeFileSync(repositoriesPath, `${JSON.stringify(repositories, null, 2)}\n`);

        expect(() => syncSources(root, true)).toThrow("source configuration is out of date");
        expect(syncSources(root)).toEqual([
            "README.md",
            "install.sh",
            "install.ps1",
            "packages/vscode/package.json",
            ".github/workflows/test.yml",
            ".github/workflows/verify-tool.yml",
        ]);
        expect(readFileSync(resolve(root, "install.sh"), "utf8")).toContain(
            "new-org/qinit/develop/install.sh",
        );
        expect(readFileSync(resolve(root, ".github/workflows/test.yml"), "utf8")).toContain(
            "branches: [develop]",
        );
        expect(readFileSync(resolve(root, ".github/workflows/verify-tool.yml"), "utf8")).toContain(
            "github.ref == 'refs/heads/develop'",
        );
        expect(syncSources(root, true)).toEqual([]);
    });

    test("rejects invalid configuration and missing targets", () => {
        const root = copySources();
        const toolchainsPath = resolve(root, "config/toolchains.json");
        const toolchains = JSON.parse(readFileSync(toolchainsPath, "utf8"));
        toolchains.wasiSdk.repository = "not a repository";
        writeFileSync(toolchainsPath, `${JSON.stringify(toolchains, null, 2)}\n`);
        expect(() => loadSourceConfig(root)).toThrow("wasiSdk.repository");

        toolchains.wasiSdk.repository = "WebAssembly/wasi-sdk";
        writeFileSync(toolchainsPath, `${JSON.stringify(toolchains, null, 2)}\n`);

        const repositoriesPath = resolve(root, "config/repositories.json");
        const repositories = JSON.parse(readFileSync(repositoriesPath, "utf8"));
        repositories.coreLite.pinnedCommit = "ABC";
        writeFileSync(repositoriesPath, `${JSON.stringify(repositories, null, 2)}\n`);
        expect(() => loadSourceConfig(root)).toThrow("coreLite.pinnedCommit");
        repositories.coreLite.pinnedCommit = "";
        writeFileSync(repositoriesPath, `${JSON.stringify(repositories, null, 2)}\n`);

        const agentsPath = resolve(root, "AGENTS.md");
        writeFileSync(agentsPath, readFileSync(agentsPath, "utf8").replace("Use Bun", "Run Bun"));
        expect(() => syncSources(root)).toThrow("expected 1 match(es)");
    });

    // Git checks out with CRLF by default on Windows. A replacement that spans newlines must keep the
    // file's endings, or --check reports drift that syncing can never settle.
    test("reports no drift in a CRLF checkout", () => {
        const root = copySources();
        for (const relativePath of synchronizedSourceFiles) {
            const path = resolve(root, relativePath);
            const source = readFileSync(path, "utf8");
            writeFileSync(path, source.replace(/\r?\n/g, "\r\n"));
        }

        expect(syncSources(root, true)).toEqual([]);
    });

    test("requires bun.lock to match the configured Bun version", () => {
        const root = copySources();
        const version = JSON.parse(readFileSync(resolve(root, "config/toolchains.json"), "utf8"))
            .bun.version;
        const lockPath = resolve(root, "bun.lock");
        writeFileSync(
            lockPath,
            readFileSync(lockPath, "utf8").replaceAll(`bun-types@${version}`, "bun-types@0.0.0"),
        );

        expect(() => syncSources(root, true)).toThrow(
            `bun.lock does not match bun.version ${version}; run bun install`,
        );
    });
});
