import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "@qinit/compiler/generated/qpi-snapshot";
import { classifyQpiDrift } from "@qinit/compiler/driver/qpi/snapshot";
import { QpiDriftKind } from "@qinit/compiler";

export const WASM_NODE_CMAKE_PROFILE = Object.freeze({
    BUILD_BINARY: "ON",
    BUILD_TESTS: "OFF",
    ENABLE_AVX512: "OFF",
    USE_SANITIZER: "OFF",
    TESTNET: "ON",
    TESTNET_LITE_RAM: "ON",
    TESTNET_PREFILL_QUS: "ON",
    LITE_WASM_SC: "ON",
    CMAKE_NO_USE_SWAP: "ON",
    ADDON_TX_STATUS_REQUEST: "ON",
    ONLY_LOGGING: "OFF",
});

type CmakeExpectation = string | RegExp;

export function assertCoreBuildProfile(core: string, buildDirectories: string[], extraExpected: Record<string, CmakeExpectation> = {}): Record<string, string> {
    const cachePath = buildDirectories.map((directory) => resolve(core, directory, "CMakeCache.txt")).find(existsSync);
    if (!cachePath) {
        throw new Error(`core build is missing CMakeCache.txt in ${buildDirectories.join(", ")}`);
    }

    const cache = readFileSync(cachePath, "utf8");
    const value = (key: string): string => {
        const match = cache.match(new RegExp(`^${key}:[^=]*=(.*)$`, "m"));
        if (!match) throw new Error(`CMake cache is missing ${key}`);
        return match[1].trim();
    };
    const expected: Record<string, CmakeExpectation> = {
        ...WASM_NODE_CMAKE_PROFILE,
        ...extraExpected,
    };
    const proof: Record<string, string> = {};

    for (const [key, wanted] of Object.entries(expected)) {
        proof[key] = value(key);
        const matches = typeof wanted === "string" ? proof[key] === wanted : wanted.test(proof[key]);
        if (!matches) {
            throw new Error(`CMake ${key}=${proof[key]}, expected ${String(wanted)}`);
        }
    }

    proof.CMAKE_CACHE = cachePath;
    return proof;
}

export function assertPinnedQpiHeader(header: string): void {
    const hash = (source: string) => `sha256:${createHash("sha256").update(source).digest("hex")}`;

    if (hash(QPI_SNAPSHOT) !== QPI_SNAPSHOT_META.snapshotHash) {
        throw new Error("generated QPI snapshot does not match its metadata");
    }

    const drift = classifyQpiDrift(header, QPI_SNAPSHOT);
    if (drift.kind === QpiDriftKind.EQUIVALENT) {
        return;
    }
    if (drift.kind === QpiDriftKind.ABI) {
        throw new Error(`core wasm ABI ${hash(header)} drifted from pinned snapshot ${QPI_SNAPSHOT_META.snapshotHash}; regenerate it and review host imports`);
    }

    const summary = `pinned QPI snapshot (core ${QPI_SNAPSHOT_META.coreCommit}) is behind the live core: ${drift.changed.join(", ")} changed`;
    console.log(`[core-proof] ${summary}`);
    console.log(`[core-proof]   live ${hash(header)} vs pinned ${QPI_SNAPSHOT_META.snapshotHash}`);
    console.log("[core-proof]   refresh with: bun packages/compiler/tools/gen-qpi-snapshot.ts --core-dir <core>");
    if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${summary}`);
    }
}
