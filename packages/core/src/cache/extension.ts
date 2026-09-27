// the editor extension ships from main on one moving release, independent of the CLI's version.
import { join } from "node:path";
import { CLI_REPO, fetchCliSha } from "./cli-release";
import { downloadVerifiedAssetToFile } from "./download";
import { downloadsDir } from "./paths";

export const EXTENSION_TAG = "qinit-vscode-latest";
export const EXTENSION_ASSET = "qpi-vscode.vsix";

export interface DownloadedExtension {
    path: string;
    url: string;
    sha256: string;
}

// the cached file is reused while the published checksum still names it; without a checksum nothing is downloaded, so nothing unverified is installed.
export async function downloadExtension(onProgress?: (recv: number, total: number) => void, repo = CLI_REPO): Promise<DownloadedExtension> {
    const base = `https://github.com/${repo}/releases/download/${EXTENSION_TAG}`;
    const sha256 = await fetchCliSha(`${base}/SHA256SUMS`, EXTENSION_ASSET);
    if (!sha256) {
        throw new Error(`no checksum for ${EXTENSION_ASSET} at ${base}/SHA256SUMS — the release is unreachable or has no build yet`);
    }

    const url = `${base}/${EXTENSION_ASSET}`;
    const path = join(downloadsDir(), EXTENSION_ASSET);
    await downloadVerifiedAssetToFile({ url, sha256 }, path, onProgress);
    return { path, url, sha256 };
}
