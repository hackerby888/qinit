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
    | { phase: "downgrade-refused"; version: string; currentVersion: string }
    | { phase: "updated"; previousVersion: string; version: string };

// the stamped format on both sides: release.yml writes MAJOR.MINOR.PATCH into version.ts, and the tag drops to the same shape.
const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(text: string): [number, number, number] {
    const match = RELEASE_VERSION.exec(text);
    if (!match) {
        throw new Error(`not a qinit release version: ${text}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** negative when `left` is older than `right`, zero when equal. */
export function compareVersions(left: string, right: string): number {
    const a = parseVersion(left);
    const b = parseVersion(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

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
            throw new Error(`could not replace ${executablePath} (${errorDetail(error)}) — ` + "close other qinit processes or re-run install.ps1");
        }
        return;
    }

    try {
        deps.chmodSync(temporaryPath, 0o755);
        deps.renameSync(temporaryPath, executablePath);
    } catch (error) {
        unlinkBestEffort(temporaryPath, deps);
        throw new Error(`could not replace ${executablePath} (${errorDetail(error)}) — ` + "bin dir not writable; re-run install.sh or use sudo");
    }
}

// a CLI started through a JavaScript runtime is a source checkout, which has no release binary to replace.
export function runsFromSource(executablePath: string): boolean {
    const executableName = basename(executablePath)
        .replace(/\.exe$/i, "")
        .toLowerCase();
    return executableName === "bun" || executableName === "node";
}

export async function runSelfUpdate(options: SelfUpdateOptions = {}, injected: Partial<SelfUpdateDeps> = {}): Promise<SelfUpdateResult> {
    const deps = { ...defaultDeps, ...injected };
    if (runsFromSource(deps.executablePath)) {
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
    const order = compareVersions(version, deps.currentVersion);
    if (order === 0 && !options.force) {
        return { phase: "up-to-date", version };
    }
    // latest.txt is a pointer anyone with repo write can move back; an older release never installs itself.
    if (order < 0 && !options.force) {
        return { phase: "downgrade-refused", version, currentVersion: deps.currentVersion };
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
