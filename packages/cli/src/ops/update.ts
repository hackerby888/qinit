import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { cliReleaseUrls, downloadVerifiedAsset, fetchCliSha, resolveCliTag } from "@qinit/core";
import { VERSION } from "../version";

export interface SelfUpdateOptions {
    force?: boolean;
    dryRun?: boolean;
    onProgress?: (received: number, total: number) => void;
}

export type SelfUpdateResult =
    | { phase: "development" }
    | {
          phase: "dry-run";
          tag: string;
          asset: string;
          currentVersion: string;
          version: string;
      }
    | { phase: "up-to-date"; version: string }
    | { phase: "updated"; previousVersion: string; version: string };

export interface SelfUpdateDeps {
    executablePath: string;
    platform: typeof process.platform;
    currentVersion: string;
    resolveCliTag: typeof resolveCliTag;
    cliReleaseUrls: typeof cliReleaseUrls;
    fetchCliSha: typeof fetchCliSha;
    downloadVerifiedAsset: typeof downloadVerifiedAsset;
    writeFileSync: typeof writeFileSync;
    chmodSync: typeof chmodSync;
    renameSync: typeof renameSync;
    unlinkSync: typeof unlinkSync;
}

const defaultDeps: SelfUpdateDeps = {
    executablePath: process.execPath,
    platform: process.platform,
    currentVersion: VERSION,
    resolveCliTag,
    cliReleaseUrls,
    fetchCliSha,
    downloadVerifiedAsset,
    writeFileSync,
    chmodSync,
    renameSync,
    unlinkSync,
};

function errorDetail(error: unknown): string {
    if (error && typeof error === "object" && "code" in error) {
        return String(error.code);
    }
    return String(error);
}

function unlinkBestEffort(path: string, deps: SelfUpdateDeps): void {
    try {
        deps.unlinkSync(path);
    } catch {}
}

function replaceExecutable(executablePath: string, binary: Uint8Array, deps: SelfUpdateDeps): void {
    const temporaryPath = `${executablePath}.new`;
    try {
        deps.writeFileSync(temporaryPath, binary);
    } catch (error) {
        unlinkBestEffort(temporaryPath, deps);
        throw error;
    }

    if (deps.platform === "win32") {
        const oldPath = `${executablePath}.old`;
        unlinkBestEffort(oldPath, deps);

        let movedCurrent = false;
        try {
            deps.renameSync(executablePath, oldPath);
            movedCurrent = true;
            deps.renameSync(temporaryPath, executablePath);
        } catch (error) {
            if (movedCurrent) {
                try {
                    deps.renameSync(oldPath, executablePath);
                } catch {}
            }
            unlinkBestEffort(temporaryPath, deps);
            throw new Error(
                `could not replace ${executablePath} (${errorDetail(error)}) — ` +
                    "close other qinit processes or re-run install.ps1",
            );
        }
        return;
    }

    try {
        deps.chmodSync(temporaryPath, 0o755);
        deps.renameSync(temporaryPath, executablePath);
    } catch (error) {
        unlinkBestEffort(temporaryPath, deps);
        throw new Error(
            `could not replace ${executablePath} (${errorDetail(error)}) — ` +
                "bin dir not writable; re-run install.sh or use sudo",
        );
    }
}

export async function runSelfUpdate(
    options: SelfUpdateOptions = {},
    injected: Partial<SelfUpdateDeps> = {},
): Promise<SelfUpdateResult> {
    const deps = { ...defaultDeps, ...injected };
    const executableName = basename(deps.executablePath)
        .replace(/\.exe$/i, "")
        .toLowerCase();
    if (executableName === "bun" || executableName === "node") {
        return { phase: "development" };
    }

    const tag = await deps.resolveCliTag();
    if (!tag) {
        throw new Error("latest.txt does not contain a valid qinit-cli release tag");
    }

    const version = tag.replace(/^qinit-cli-v?/, "");
    const { asset, sums, name } = deps.cliReleaseUrls(tag);
    if (options.dryRun) {
        return {
            phase: "dry-run",
            tag,
            asset,
            currentVersion: deps.currentVersion,
            version,
        };
    }
    if (version === deps.currentVersion && !options.force) {
        return { phase: "up-to-date", version };
    }

    const sha256 = await deps.fetchCliSha(sums, name);
    const binary = await deps.downloadVerifiedAsset({ url: asset, sha256 }, options.onProgress);
    replaceExecutable(deps.executablePath, binary, deps);
    return {
        phase: "updated",
        previousVersion: deps.currentVersion,
        version,
    };
}
