// qinit CLI self-update / install resolution (the CLI binary release; mirrors install.sh).
import { fetchWithTimeout } from "../net/http";
import { debug } from "../debug/log";
import repositories from "../../../../config/repositories.json";

export const CLI_REPO = process.env.QINIT_REPOSITORY ?? repositories.qinit.repository;

// qinit-<os>-<arch>[.exe] asset for this host. Windows ships only x64 (bun-windows-x64) — ARM64 Windows
// runs that under emulation, so map win/arm64 -> x64.
export function cliAssetName(): string {
    const platform = process.platform;
    const os = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : "";
    const arch = platform === "win32" ? "x64" : process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "";
    if (!os || !arch) {
        throw new Error(`unsupported host for self-update: ${platform}/${process.arch}`);
    }
    return `qinit-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

// Resolve the newest CLI tag through the stable release pointer. null if its contents are invalid.
export async function resolveCliTag(repo = CLI_REPO): Promise<string | null> {
    const url = `https://github.com/${repo}/releases/download/qinit-cli-latest/latest.txt`;
    const response = await fetchWithTimeout(url, undefined, 15000);
    if (!response.ok) {
        throw new Error(`CLI release pointer fetch failed (HTTP ${response.status}) from ${url}`);
    }
    const tag = (await response.text()).trim();
    return /^qinit-cli-[A-Za-z0-9._-]+$/.test(tag) ? tag : null;
}

export function cliReleaseUrls(tag: string, repo = CLI_REPO): { asset: string; sums: string; name: string } {
    const name = cliAssetName();
    const base = `https://github.com/${repo}/releases/download/${tag}`;
    return { asset: `${base}/${name}`, sums: `${base}/SHA256SUMS`, name };
}

// Pull the sha256 for `name` from a SHA256SUMS file ("<sha>  <name>" lines); "" if missing/unreachable.
export async function fetchCliSha(sumsUrl: string, name: string): Promise<string> {
    try {
        const response = await fetchWithTimeout(sumsUrl, undefined, 15000);
        if (!response.ok) return "";
        for (const line of (await response.text()).split("\n")) {
            const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/);
            if (match && match[2] === name) return match[1].toLowerCase();
        }
    } catch (e) {
        debug("fetchCliSha: SHA256SUMS fetch failed", e);
    }
    return "";
}
