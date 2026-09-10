// Fetching bytes onto disk: hash-verified, resumable downloads, atomic writes, tarball extraction.
import { createHash, type Hash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fetchWithTimeout, readResponseChunksWithTimeout } from "../net/http";
import type { AssetRef } from "./manifest";
import { downloadsDir } from "./paths";

export function sha256Hex(buf: Uint8Array): string {
    return createHash("sha256").update(buf).digest("hex");
}

// Write a file atomically: a kill mid-write must never leave a torn file existsSync treats as a cache hit, so write a sibling tmp and rename.
export function atomicWrite(file: string, data: Uint8Array | string): void {
    const tempFile = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tempFile, data);
    renameSync(tempFile, file);
}

export interface DownloadOptions {
    /** Total attempts before giving up (default 3). */
    attempts?: number;
    /** Inactivity watchdog while the body streams (default 60 s). */
    stallMs?: number;
    /** Base delay between attempts, multiplied by the attempt number (default 2 s). */
    backoffMs?: number;
    /** Where the partial download lives (default `<destPath>.part`). */
    partPath?: string;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DownloadAttemptError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
        readonly resumable = true,
    ) {
        super(message);
    }
}

// Feed an existing file through a hash without loading it whole; returns its size.
function hashFile(path: string, hash: Hash): number {
    const fd = openSync(path, "r");
    const buffer = new Uint8Array(1 << 20);
    let size = 0;
    try {
        for (;;) {
            const n = readSync(fd, buffer, 0, buffer.length, null);
            if (n <= 0) break;
            hash.update(buffer.subarray(0, n));
            size += n;
        }
    } finally {
        closeSync(fd);
    }
    return size;
}

function fileSha256(path: string): string {
    const hash = createHash("sha256");
    hashFile(path, hash);
    return hash.digest("hex");
}

async function downloadAttempt(
    asset: AssetRef,
    part: string,
    destPath: string,
    onProgress: ((recv: number, total: number) => void) | undefined,
    stallMs: number,
    resumable: boolean,
): Promise<void> {
    if (!resumable) rmSync(part, { force: true });
    let offset = existsSync(part) ? statSync(part).size : 0;

    let response: Response;
    try {
        response = await fetchWithTimeout(asset.url, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : undefined, 30000);
    } catch (e: any) {
        throw new DownloadAttemptError(`network error — check your connection  [${e?.message ?? e}]`, true);
    }

    let hash = createHash("sha256");
    let fd: number;
    if (offset > 0 && response.status === 206) {
        hashFile(part, hash); // continue where the last attempt stopped
        fd = openSync(part, "a");
    } else if (offset > 0 && response.status === 416) {
        return finish(asset, part, destPath, hash, hashFile(part, hash), true);
    } else if (response.ok) {
        offset = 0; // the server ignored the range (or there was none): start over
        hash = createHash("sha256");
        fd = openSync(part, "w");
    } else {
        throw new DownloadAttemptError(`download failed (HTTP ${response.status})`, RETRYABLE_STATUSES.has(response.status));
    }

    let received = 0;
    let total = 0;
    try {
        ({ received, total } = await readResponseChunksWithTimeout(response, stallMs, (chunk, got, length) => {
            writeSync(fd, chunk);
            hash.update(chunk);
            onProgress?.(offset + got, length > 0 ? offset + length : 0);
        }));
    } catch (e: any) {
        throw new DownloadAttemptError(`connection dropped after ${offset + received} bytes  [${e?.message ?? e}]`, true);
    } finally {
        closeSync(fd);
    }
    if (total > 0 && received < total) {
        throw new DownloadAttemptError(`body ended after ${received} of ${total} bytes`, true);
    }
    finish(asset, part, destPath, hash, offset + received, offset > 0);
}

function finish(asset: AssetRef, part: string, destPath: string, hash: Hash, size: number, resumed: boolean): void {
    if (asset.sha256) {
        const actualSha = hash.digest("hex");
        if (actualSha !== asset.sha256) {
            rmSync(part, { force: true });
            // A resumed .part may be stale, so try once more from zero; a fresh download that mismatches is final.
            throw new DownloadAttemptError(`sha256 mismatch after ${size} bytes\n  want ${asset.sha256}\n  got  ${actualSha}`, resumed, false);
        }
    }
    renameSync(part, destPath);
}

// Stream an asset to disk through a `.part` file: retried with backoff, resumed by HTTP Range where allowed, sha256-verified, renamed only when complete.
export async function downloadVerifiedAssetToFile(
    asset: AssetRef,
    destPath: string,
    onProgress?: (recv: number, total: number) => void,
    options: DownloadOptions = {},
): Promise<void> {
    const attempts = Math.max(1, options.attempts ?? 3);
    const stallMs = options.stallMs ?? 60000;
    const backoffMs = options.backoffMs ?? 2000;
    const part = options.partPath ?? `${destPath}.part`;
    mkdirSync(dirname(destPath), { recursive: true });

    if (existsSync(destPath)) {
        if (!asset.sha256 || fileSha256(destPath) === asset.sha256) return;
        rmSync(destPath, { force: true });
    }

    let resumable = true;
    for (let attempt = 1; ; attempt++) {
        try {
            await downloadAttempt(asset, part, destPath, onProgress, stallMs, resumable);
            return;
        } catch (e: any) {
            const retryable = e instanceof DownloadAttemptError ? e.retryable : false;
            if (e instanceof DownloadAttemptError && !e.resumable) resumable = false;
            if (!retryable || attempt >= attempts) {
                throw new Error(`download failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${asset.url} — last error: ${e?.message ?? e}`);
            }
            await sleep(backoffMs * attempt);
        }
    }
}

// The in-memory variant for small assets (node binary metadata, headers, tools): same download path, read back once.
export async function downloadVerifiedAsset(asset: AssetRef, onProgress?: (recv: number, total: number) => void): Promise<Uint8Array> {
    const name = basename(asset.url.split(/[?#]/)[0] ?? "") || "asset";
    const file = join(downloadsDir(), `${name}.${process.pid}.${Date.now()}`);
    try {
        await downloadVerifiedAssetToFile(asset, file, onProgress);
        return new Uint8Array(readFileSync(file));
    } finally {
        rmSync(file, { force: true });
        rmSync(`${file}.part`, { force: true });
    }
}

// Extract a .tar.gz (in memory, or a file on disk) into destDir (system tar; gzip is universal — no zstd dep).
export async function extractTarGz(tarGz: Uint8Array | string, destDir: string): Promise<void> {
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
    // Extract via the spawn cwd, not `tar -C <dir>`: Windows Git-bash MSYS tar mangles a drive path passed to -C, while cwd is applied by the OS.
    const tarProcess = Bun.spawn(["tar", "xzf", "-"], {
        stdin: typeof tarGz === "string" ? Bun.file(tarGz) : tarGz,
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
