import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSnapshot } from "@qinit/build";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const resources = join(packageRoot, "resources");
const required = [
    join(resources, "core-headers", "src", "qpi", "qpi.h"),
    join(
        resources,
        "core-headers",
        "wasi-sdk",
        "share",
        "wasi-sysroot",
        "include",
        "wasm32-wasi",
        "c++",
        "v1",
        "cstdint",
    ),
    join(resources, "snapshot.json"),
];
if (process.argv.includes("--check")) {
    if (required.some((path) => !existsSync(path))) {
        throw new Error("bundled headers are missing — run `bun run prepare:headers`");
    }
    console.log("bundled headers ready");
    process.exit(0);
}

const repositories = JSON.parse(
    readFileSync(join(repositoryRoot, "config", "repositories.json"), "utf8"),
) as {
    coreLite: { repository: string };
};
const snapshotManifest = JSON.parse(
    readFileSync(join(repositoryRoot, "packages", "compiler", "core-snapshot.json"), "utf8"),
) as { coreCommit: string };
const core = resolve(process.argv[2] ?? process.env.QINIT_CORE ?? "");
if (!core || !existsSync(join(core, "src", "qpi", "qpi.h"))) {
    throw new Error("pass a pinned core-lite checkout or set QINIT_CORE");
}

const revision = Bun.spawnSync(["git", "-C", core, "rev-parse", "HEAD"]);
const actualCommit = revision.stdout.toString().trim();
if (revision.exitCode !== 0 || actualCommit !== snapshotManifest.coreCommit) {
    throw new Error(
        `core commit ${actualCommit || "unknown"} does not match ` + snapshotManifest.coreCommit,
    );
}

mkdirSync(resources, { recursive: true });
const snapshot = await buildSnapshot(core, resources, { includeSdkHeaders: true });
if (required.slice(0, 2).some((path) => !existsSync(path))) {
    throw new Error("generated snapshot is missing QPI or C++ headers");
}

writeFileSync(
    join(resources, "snapshot.json"),
    JSON.stringify(
        {
            coreRepository: repositories.coreLite.repository,
            coreCommit: snapshotManifest.coreCommit,
            fileCount: snapshot.fileCount,
        },
        null,
        2,
    ) + "\n",
);
console.log(`prepared ${snapshot.fileCount} headers from ${snapshotManifest.coreCommit}`);
