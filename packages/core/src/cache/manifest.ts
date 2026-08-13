// The core-lite release manifest: one version pinning an ABI-consistent {node, headers} set.
import { fetchWithTimeout } from "../net/http";
import repositories from "../../../../config/repositories.json";

export const RELEASE_REPO = process.env.QINIT_CORE_REPOSITORY ?? repositories.coreLite.repository;

export interface AssetRef {
    url: string;
    sha256: string;
}
export interface ReleaseSource {
    repository: string;
    commit: string;
}
// node = back-compat (linux-x64); nodes = per-platform map keyed by releasePlatformKey() (linux-x64, linux-arm64, …)
export interface Manifest {
    version: string;
    sources?: {
        coreLite: ReleaseSource;
        qinit: ReleaseSource;
    };
    node?: AssetRef;
    nodes?: Record<string, AssetRef>;
    headers?: AssetRef;
}

// A manifest may name an asset by filename instead of a full URL; expand it against the release tag.
// Anything that is neither a plain https URL nor a safe filename is rejected rather than fetched.
export function resolveReleaseAsset(
    asset: AssetRef,
    repo: string,
    tag: string,
    label: string,
): AssetRef {
    const value = asset?.url;
    if (typeof value !== "string") {
        throw new Error(`${label} URL must be an HTTPS URL or asset filename`);
    }
    try {
        if (/^https:\/\//i.test(value) && new URL(value).protocol === "https:") {
            return asset;
        }
    } catch {}
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error(`${label} URL must be an HTTPS URL or asset filename`);
    }
    if (typeof tag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
        throw new Error(`${label} release tag is invalid: ${tag}`);
    }
    return {
        ...asset,
        url: `https://github.com/${repo}/releases/download/${tag}/${value}`,
    };
}

export function resolveReleaseAssets(
    assets: Record<string, AssetRef>,
    repo: string,
    tag: string,
    label: string,
): Record<string, AssetRef> {
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
        throw new Error(`${label} assets must be an object`);
    }
    return Object.fromEntries(
        Object.entries(assets).map(([key, asset]) => [
            key,
            resolveReleaseAsset(asset, repo, tag, `${label} asset ${key}`),
        ]),
    );
}

// Pull the release manifest that pins {node, headers} for one version (ABI-consistent set).
export async function loadManifest(ref = "latest", repo = RELEASE_REPO): Promise<Manifest> {
    const path = ref === "latest" ? "latest/download" : `download/${ref}`;
    const url = `https://github.com/${repo}/releases/${path}/qinit-manifest.json`;
    const response = await fetchWithTimeout(url, undefined, 15000);
    if (!response.ok) {
        throw new Error(`manifest fetch failed (HTTP ${response.status}) from ${url}`);
    }
    const manifest = (await response.json()) as Manifest;
    if (manifest.node !== undefined) {
        manifest.node = resolveReleaseAsset(manifest.node, repo, manifest.version, "core node");
    }
    if (manifest.nodes !== undefined) {
        manifest.nodes = resolveReleaseAssets(manifest.nodes, repo, manifest.version, "core node");
    }
    if (manifest.headers !== undefined) {
        manifest.headers = resolveReleaseAsset(
            manifest.headers,
            repo,
            manifest.version,
            "core headers",
        );
    }
    return manifest;
}
