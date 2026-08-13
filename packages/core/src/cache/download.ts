// Fetching bytes onto disk: hash-verified downloads, atomic writes, tarball extraction.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { fetchWithTimeout, readResponseBodyWithTimeout } from "../net/http";
import type { AssetRef } from "./manifest";

export function sha256Hex(buf: Uint8Array): string {
    return createHash("sha256").update(buf).digest("hex");
}

// Write a file atomically: a kill mid-write must never leave a torn file that existsSync treats as a
// valid cache hit. Write a sibling tmp, then rename (atomic on the same filesystem).
export function atomicWrite(file: string, data: Uint8Array | string): void {
    const tempFile = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tempFile, data);
    renameSync(tempFile, file);
}

// Download an asset and verify its sha256 (mismatch => throw, never cache a bad blob).
// onProgress(received, total) streams download bytes for a live progress bar.
export async function downloadVerifiedAsset(
    asset: AssetRef,
    onProgress?: (recv: number, total: number) => void,
): Promise<Uint8Array> {
    let response: Response;
    try {
        response = await fetchWithTimeout(asset.url, undefined, 30000);
    } catch (e: any) {
        // 30s connect/TTFB guard; the body then streams untimed
        throw new Error(
            `network error downloading ${asset.url} — check your connection  [${e?.message ?? e}]`,
        );
    }
    if (!response.ok) {
        throw new Error(`download failed (HTTP ${response.status}): ${asset.url}`);
    }
    const buffer = await readResponseBodyWithTimeout(response, 60000, onProgress);
    if (asset.sha256) {
        const actualSha = sha256Hex(buffer);
        if (actualSha !== asset.sha256) {
            throw new Error(
                `sha256 mismatch for ${asset.url}\n  want ${asset.sha256}\n  got  ${actualSha}`,
            );
        }
    }
    return buffer;
}

// Extract a .tar.gz buffer into destDir (system tar; gzip is universal — no zstd dep).
export async function extractTarGz(tarGz: Uint8Array, destDir: string): Promise<void> {
    mkdirSync(destDir, { recursive: true });
    // Fail clearly when the fetch path's only external tool is unavailable.
    if (!Bun.which("tar")) {
        throw new Error(
            process.platform === "win32"
                ? "`tar` not found on PATH. Windows 10 (1803+) and 11 include it at " +
                      "C:\\Windows\\System32\\tar.exe — if it's missing, install Git for Windows " +
                      "(it ships tar) and reopen your terminal."
                : "`tar` not found on PATH — install it with your package manager (e.g. `apt install tar`).",
        );
    }
    // Extract via the spawn cwd, not `tar -C <dir>`: on Windows the Git-bash MSYS tar mangles a
    // `C:\...` path passed to -C ("Cannot open"). cwd is applied by the OS, so tar never parses it.
    const tarProcess = Bun.spawn(["tar", "xzf", "-"], {
        stdin: tarGz,
        cwd: destDir,
        stdout: "pipe",
        stderr: "pipe",
    });
    const stderr = await new Response(tarProcess.stderr).text();
    await tarProcess.exited;
    if (tarProcess.exitCode !== 0) {
        throw new Error("tar extract failed: " + stderr);
    }
}
