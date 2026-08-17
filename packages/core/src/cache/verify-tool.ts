// contractverify tool distribution + auto-update. The verifier ships independently from core and the CLI.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchWithTimeout } from "../net/http";
import { CLI_REPO } from "./cli-release";
import { downloadVerifiedAsset } from "./download";
import { type AssetRef, resolveReleaseAssets } from "./manifest";
import { readCurrent, releasePlatformKey, toolsDir, updateCurrent } from "./paths";

export const VERIFY_REPO = CLI_REPO;
export const VERIFY_TAG = "verify-latest";
export interface VerifyManifest {
    version: string;
    assets: Record<string, AssetRef>;
}

export function cachedVerifyToolPath(): string {
    return join(toolsDir(), process.platform === "win32" ? "contractverify.exe" : "contractverify");
}

export async function loadVerifyManifest(repo = VERIFY_REPO): Promise<VerifyManifest> {
    const url = `https://github.com/${repo}/releases/download/${VERIFY_TAG}/verify-manifest.json`;
    const response = await fetchWithTimeout(url, undefined, 15000);
    if (!response.ok) {
        throw new Error(`verify manifest fetch failed (HTTP ${response.status})`);
    }
    const manifest = (await response.json()) as VerifyManifest;
    manifest.assets = resolveReleaseAssets(manifest.assets, repo, VERIFY_TAG, "verify");
    return manifest;
}

export interface VerifyUpdate {
    action: "none" | "installed" | "updated" | "current" | "offline" | "unsupported";
    version?: string;
}
// Daily-cached, best-effort — never throws; `force` skips the age gate; offline/unreachable = no-op.
export async function autoUpdateVerifyTool(opts?: {
    force?: boolean;
    maxAgeMs?: number;
    onProgress?: (recv: number, total: number) => void;
}): Promise<VerifyUpdate> {
    if (process.env.QINIT_NO_UPDATE) return { action: "none" };
    const cur = readCurrent() ?? {};
    const maxAge = opts?.maxAgeMs ?? 24 * 3600 * 1000;
    const last = cur.verifyCheckedAt ? Date.parse(cur.verifyCheckedAt) : 0;
    if (!opts?.force && Date.now() - last < maxAge) return { action: "none" };

    let m: VerifyManifest;
    try {
        m = await loadVerifyManifest();
    } catch {
        return { action: "offline" };
    }
    const asset = m.assets[releasePlatformKey()];
    if (!asset) {
        updateCurrent({ verifyCheckedAt: new Date().toISOString() });
        return { action: "unsupported" };
    }

    const tool = cachedVerifyToolPath();
    const have = existsSync(tool);
    if (have && cur.verifySha === asset.sha256) {
        updateCurrent({ verifyCheckedAt: new Date().toISOString() });
        return { action: "current", version: m.version };
    }
    try {
        const buf = await downloadVerifiedAsset(asset, opts?.onProgress);
        mkdirSync(toolsDir(), { recursive: true });
        writeFileSync(tool, buf);
        if (process.platform !== "win32") Bun.spawnSync(["chmod", "+x", tool]); // no chmod on Windows (no exec bit)
        updateCurrent({
            verify: tool,
            verifySha: asset.sha256,
            verifyVersion: m.version,
            verifyCheckedAt: new Date().toISOString(),
        });
        return { action: have ? "updated" : "installed", version: m.version };
    } catch {
        return { action: "offline" };
    }
}
