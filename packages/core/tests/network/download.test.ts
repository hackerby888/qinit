// Resumable downloads: a dropped body is retried with a Range header, verified, and only then renamed into place.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadVerifiedAsset, downloadVerifiedAssetToFile, extractTarGz } from "../../src/cache/download";

const originalFetch = globalThis.fetch;
const originalCache = process.env.QINIT_CACHE;
const dirs: string[] = [];
const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "qinit-download-"));
    dirs.push(d);
    return d;
};

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) delete process.env.QINIT_CACHE;
    else process.env.QINIT_CACHE = originalCache;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const URL_ = "https://example.invalid/releases/asset.bin";
const body = new Uint8Array(64 * 1024).map((_, i) => (i * 7 + 3) & 0xff);
const sha256 = createHash("sha256").update(body).digest("hex");
const fast = { backoffMs: 1 };

interface Served {
    requests: { range: string | null }[];
}

// A fake server for `body`: optional drop after N bytes on the first request, optional Range support.
function serve(options: { dropAfter?: number; ranges?: boolean; contentLength?: boolean; status?: number } = {}): Served {
    const served: Served = { requests: [] };
    const ranges = options.ranges ?? true;
    const withLength = options.contentLength ?? true;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("range");
        served.requests.push({ range });
        if (options.status) return new Response("nope", { status: options.status });
        const first = served.requests.length === 1;
        const start = ranges && range ? Number(range.replace("bytes=", "").replace("-", "")) : 0;
        const slice = body.subarray(start);
        const dropAt = first && options.dropAfter !== undefined ? options.dropAfter : slice.length;
        // Erroring a stream discards its queue, so the partial chunk is handed out on one pull and the drop on the next.
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulls++ === 0) {
                    controller.enqueue(slice.subarray(0, dropAt));
                } else if (dropAt < slice.length) {
                    controller.error(new Error("The socket connection was closed unexpectedly."));
                } else {
                    controller.close();
                }
            },
        });
        const headers: Record<string, string> = {};
        if (withLength) headers["content-length"] = String(slice.length);
        if (start > 0) headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
        return new Response(stream, { status: start > 0 ? 206 : 200, headers });
    }) as unknown as typeof fetch;
    return served;
}

test("streams to a .part file and renames it into place once the sha256 checks out", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    const progress: [number, number][] = [];
    serve();

    await downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, (r, t) => progress.push([r, t]), fast);

    expect(readFileSync(dest)).toEqual(Buffer.from(body));
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(progress.at(-1)).toEqual([body.length, body.length]);
});

test("resumes with a Range request after the connection drops mid-body", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    const served = serve({ dropAfter: 10_000 });

    await downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, undefined, fast);

    expect(served.requests.map((r) => r.range)).toEqual([null, "bytes=10000-"]);
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
    expect(existsSync(`${dest}.part`)).toBe(false);
});

test("a stale .part left by an earlier run is continued, not restarted", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    writeFileSync(`${dest}.part`, body.subarray(0, 4096));
    const served = serve();

    await downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, undefined, fast);

    expect(served.requests.map((r) => r.range)).toEqual(["bytes=4096-"]);
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
});

test("a server that ignores Range gets a clean restart", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    writeFileSync(`${dest}.part`, new Uint8Array([9, 9, 9]));
    serve({ ranges: false });

    await downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, undefined, fast);

    expect(readFileSync(dest)).toEqual(Buffer.from(body));
});

test("a body shorter than content-length is retried instead of accepted", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    let calls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        calls++;
        const range = new Headers(init?.headers).get("range");
        const start = range ? Number(range.replace("bytes=", "").replace("-", "")) : 0;
        const slice = calls === 1 ? body.subarray(0, 100) : body.subarray(start);
        return new Response(slice, { status: start > 0 ? 206 : 200, headers: { "content-length": String(body.length - start) } });
    }) as unknown as typeof fetch;

    await downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, undefined, fast);

    expect(calls).toBe(2);
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
});

test("gives up after the configured attempts with one message naming the URL and the last error", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    globalThis.fetch = (async () => {
        throw new Error("The socket connection was closed unexpectedly.");
    }) as unknown as typeof fetch;

    await expect(downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, undefined, { ...fast, attempts: 2 })).rejects.toThrow(
        /download failed after 2 attempts: https:\/\/example\.invalid\/releases\/asset\.bin — last error: network error.*socket connection/,
    );
    expect(existsSync(dest)).toBe(false);
});

test("a fresh download with the wrong sha256 fails at once and leaves no .part behind", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    const served = serve();

    await expect(downloadVerifiedAssetToFile({ url: URL_, sha256: "0".repeat(64) }, dest, undefined, fast)).rejects.toThrow(
        /after 1 attempt: .*sha256 mismatch/,
    );
    expect(served.requests).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
});

test("a resumed .part that hashes wrong is thrown away and fetched once more from zero", async () => {
    const dir = tmp();
    const dest = join(dir, "asset.bin");
    writeFileSync(`${dest}.part`, new Uint8Array(4096).fill(1)); // not the real first 4096 bytes
    const served = serve();

    await downloadVerifiedAssetToFile({ url: URL_, sha256 }, dest, undefined, fast);

    expect(served.requests.map((r) => r.range)).toEqual(["bytes=4096-", null]);
    expect(readFileSync(dest)).toEqual(Buffer.from(body));
});

test("a 404 is not retried", async () => {
    const dir = tmp();
    const served = serve({ status: 404 });

    await expect(downloadVerifiedAssetToFile({ url: URL_, sha256 }, join(dir, "asset.bin"), undefined, fast)).rejects.toThrow(/HTTP 404/);
    expect(served.requests).toHaveLength(1);
});

test("the in-memory variant returns the body and leaves the downloads directory clean", async () => {
    const cache = tmp();
    process.env.QINIT_CACHE = cache;
    serve({ dropAfter: 500 });

    const bytes = await downloadVerifiedAsset({ url: URL_, sha256 });

    expect(bytes).toEqual(body);
    expect(readdirSync(join(cache, "downloads"))).toEqual([]);
});

test("extractTarGz accepts an archive path and streams it from disk", async () => {
    const src = tmp();
    writeFileSync(join(src, "hello.txt"), "hi");
    const archive = Bun.spawnSync(["tar", "czf", "-", "."], { cwd: src }).stdout;
    const archivePath = join(tmp(), "a.tar.gz");
    writeFileSync(archivePath, archive);
    const out = tmp();

    await extractTarGz(archivePath, out);

    expect(readFileSync(join(out, "hello.txt"), "utf8")).toBe("hi");
});
