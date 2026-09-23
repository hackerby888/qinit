// Ensure node lifecycle operations target only the tracked detached process.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { releasePlatformKey } from "@qinit/core";
import {
    activeNodeScratchDir,
    busyPorts,
    ensureNodeBinary,
    fetchNodeBinary,
    identifiedPidCount,
    isNodeCommand,
    killNode,
    launchNode,
    nodeAlive,
    nodeAssetForPlatform,
    versionDrift,
} from "../../src/ops/node";

test("versionDrift only compares two managed release refs", () => {
    // The pointer a --core-dir/--node-bin session leaves behind: local headers, last downloaded node.
    expect(versionDrift({ headersVersion: "local", nodeVersion: "qinit-v0.0.47" })).toBe(false);
    expect(versionDrift({ headersVersion: "qinit-v1", nodeVersion: "qinit-v2" })).toBe(true);
    expect(versionDrift({ headersVersion: "qinit-v1", nodeVersion: "qinit-v1" })).toBe(false);
    expect(versionDrift({ headersVersion: "qinit-v1" })).toBe(false);
    expect(versionDrift({ nodeVersion: "qinit-v1" })).toBe(false);
    expect(versionDrift({ headersVersion: "cached", nodeVersion: "qinit-v1" })).toBe(false);
    expect(versionDrift({ headersVersion: "qinit-v1", nodeVersion: "unknown" })).toBe(false);
    expect(versionDrift(null)).toBe(false);
});

const scratch = () => mkdtempSync(join(tmpdir(), "qinit-nodeops-"));
const pidFile = (s: string) => join(s, "node.pid");
// A detached, long-lived process (own group -> not a child of the test runner, so no zombie on death).
// `__serve` is the simulator node's own argv marker, so the tracked pid passes the identity check like a real node.
const sleeper = (argv: string[] = ["__serve"]): number => {
    const c = spawn("bun", ["-e", "setTimeout(() => {}, 30000)", ...argv], {
        detached: true,
        stdio: "ignore",
    });
    c.unref();
    return c.pid!;
};
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("killNode stops ONLY the tracked PID, not an unrelated process", async () => {
    const dir = scratch();
    const mine = sleeper(); // the node qinit manages
    const other = sleeper(); // an unrelated instance that must survive
    try {
        writeFileSync(pidFile(dir), String(mine));
        expect(await killNode(dir)).toBe(true);
        expect(alive(mine)).toBe(false);
        expect(alive(other)).toBe(true);
        expect(existsSync(pidFile(dir))).toBe(false);
    } finally {
        try {
            process.kill(other, "SIGKILL");
        } catch {}
        try {
            process.kill(mine, "SIGKILL");
        } catch {}
        rmSync(dir, { recursive: true, force: true });
    }
});

// a pidfile outliving its node names whatever process got the number next; that process is nobody's node.
test("a tracked pid running something else is forgotten, not killed", async () => {
    const dir = scratch();
    const stranger = sleeper([]);
    try {
        writeFileSync(pidFile(dir), String(stranger));
        expect(nodeAlive(dir)).toBe(false);
        expect(alive(stranger)).toBe(true);
        expect(existsSync(pidFile(dir))).toBe(false);

        writeFileSync(pidFile(dir), String(stranger));
        expect(await killNode(dir)).toBe(false);
        expect(alive(stranger)).toBe(true);
        expect(existsSync(pidFile(dir))).toBe(false);
    } finally {
        try {
            process.kill(stranger, "SIGKILL");
        } catch {}
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a node is core's Qubic binary by exact name, or this CLI serving the simulator", () => {
    for (const argv of [
        ["Qubic"],
        ["/c/qinit-v1/node/Qubic", "--peers", "127.0.0.1"],
        ["C:\\q\\node\\Qubic.exe"],
        ["qubic"],
        ["bun", "index.tsx", "__serve", "--rpc", "http://x"],
        ["/usr/local/bin/qinit", "__serve"],
    ]) {
        expect(isNodeCommand(argv), argv.join(" ")).toBe(true);
    }
    for (const argv of [["QubicBackendServer"], ["/opt/Qubic.exe.bak"], ["qubic-cli"], ["bun", "-e", "x"], []]) {
        expect(isNodeCommand(argv), argv.join(" ")).toBe(false);
    }
});

// waitTicking polls nodeAlive every second, and on Windows each identity probe is a PowerShell start.
test("polling a tracked node identifies its pid once", async () => {
    const dir = scratch();
    const mine = sleeper();
    try {
        writeFileSync(pidFile(dir), String(mine));
        // let the child finish exec, since an unreadable command line is deliberately not cached
        await sleep(300);
        const before = identifiedPidCount();
        for (let poll = 0; poll < 5; poll++) {
            expect(nodeAlive(dir)).toBe(true);
        }
        expect(identifiedPidCount()).toBe(before + 1);
    } finally {
        try {
            process.kill(mine, "SIGKILL");
        } catch {}
        rmSync(dir, { recursive: true, force: true });
    }
});

// node run probes the ports a node will bind, so a taken port is named before launch instead of in node.log after.
test("busyPorts reports a port held on either host and forgets it once released", () => {
    for (const hostname of ["127.0.0.1", "0.0.0.0"]) {
        const held = Bun.listen({ hostname, port: 0, socket: { data() {} } });
        const port = held.port;
        const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
        const freePort = free.port;
        free.stop(true);
        try {
            expect(busyPorts([port, freePort]), hostname).toEqual([port]);
        } finally {
            held.stop(true);
        }
        expect(busyPorts([port]), hostname).toEqual([]);
    }
});

test("killNode is a no-op (no throw, no broad kill) when there is no pidfile", async () => {
    const dir = scratch();
    const bystander = sleeper();
    try {
        expect(await killNode(dir)).toBe(false);
        expect(alive(bystander)).toBe(true);
    } finally {
        try {
            process.kill(bystander, "SIGKILL");
        } catch {}
        rmSync(dir, { recursive: true, force: true });
    }
});

test("nodeAlive reflects the tracked PID's liveness", async () => {
    const dir = scratch();
    const mine = sleeper();
    try {
        writeFileSync(pidFile(dir), String(mine));
        expect(nodeAlive(dir)).toBe(true);
        process.kill(mine, "SIGKILL");
        for (let i = 0; i < 20 && alive(mine); i++) await sleep(100);
        expect(nodeAlive(dir)).toBe(false);
    } finally {
        try {
            process.kill(mine, "SIGKILL");
        } catch {}
        rmSync(dir, { recursive: true, force: true });
    }
});

test("default lifecycle operations follow the persisted active scratch directory", async () => {
    const cache = scratch();
    const customScratch = join(cache, "custom-run");
    const mine = sleeper();
    const originalCache = process.env.QINIT_CACHE;

    try {
        process.env.QINIT_CACHE = cache;
        mkdirSync(customScratch);
        writeFileSync(pidFile(customScratch), String(mine));
        writeFileSync(join(cache, "active-node-scratch"), customScratch);

        expect(activeNodeScratchDir()).toBe(customScratch);
        expect(nodeAlive()).toBe(true);
        expect(await killNode()).toBe(true);
        expect(alive(mine)).toBe(false);
        expect(existsSync(join(cache, "active-node-scratch"))).toBe(false);
    } finally {
        if (originalCache === undefined) {
            delete process.env.QINIT_CACHE;
        } else {
            process.env.QINIT_CACHE = originalCache;
        }
        try {
            process.kill(mine, "SIGKILL");
        } catch {}
        rmSync(cache, { recursive: true, force: true });
    }
});

test("node assets follow manifest platform keys and keep the legacy Linux fallback", () => {
    const legacy = { url: "legacy", sha256: "legacy-sha" };
    const windows = { url: "windows", sha256: "windows-sha" };
    const manifest = {
        version: "v1",
        node: legacy,
        nodes: { "windows-x64": windows },
    };

    expect(nodeAssetForPlatform(manifest, "windows-x64")).toBe(windows);
    expect(nodeAssetForPlatform(manifest, "linux-x64")).toBe(legacy);
    expect(nodeAssetForPlatform(manifest, "darwin-x64")).toBeUndefined();
    expect(nodeAssetForPlatform(manifest, "future-riscv64")).toBeUndefined();
});

test("fetchNodeBinary downloads a verified raw platform executable and updates current", async () => {
    const cache = scratch();
    const originalCache = process.env.QINIT_CACHE;
    const originalFetch = globalThis.fetch;
    const bytes = new Uint8Array([0x51, 0x55, 0x42, 0x49, 0x43]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const platform = releasePlatformKey();
    const filename = process.platform === "win32" ? "Qubic.exe" : "Qubic";

    try {
        process.env.QINIT_CACHE = cache;
        globalThis.fetch = (async () =>
            new Response(bytes, {
                headers: { "content-length": String(bytes.length) },
            })) as unknown as typeof fetch;

        const manifest = {
            version: "qinit-v-direct-node",
            nodes: {
                [platform]: {
                    url: "https://example.invalid/Qubic-node",
                    sha256,
                },
            },
        };
        const downloaded = await fetchNodeBinary("unused", undefined, manifest);

        expect(basename(downloaded.nodeBinaryPath)).toBe(filename);
        expect(readFileSync(downloaded.nodeBinaryPath)).toEqual(Buffer.from(bytes));
        expect(downloaded.version).toBe(manifest.version);

        const current = JSON.parse(readFileSync(join(cache, "current.json"), "utf8"));
        expect(current.nodeVersion).toBe(manifest.version);
        expect(current.node).toBe(downloaded.nodeBinaryPath);

        const staged = await fetchNodeBinary("unused", undefined, { ...manifest, version: "qinit-v-staged-node" }, { updateCurrent: false });
        expect(existsSync(staged.nodeBinaryPath)).toBe(true);
        expect(JSON.parse(readFileSync(join(cache, "current.json"), "utf8")).nodeVersion).toBe(manifest.version);

        const badManifest = {
            ...manifest,
            version: "qinit-v-bad-node",
            nodes: {
                [platform]: {
                    ...manifest.nodes[platform],
                    sha256: "0".repeat(64),
                },
            },
        };
        await expect(fetchNodeBinary("unused", undefined, badManifest)).rejects.toThrow("sha256 mismatch");
        expect(existsSync(join(cache, badManifest.version, "node", filename))).toBe(false);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalCache === undefined) {
            delete process.env.QINIT_CACHE;
        } else {
            process.env.QINIT_CACHE = originalCache;
        }
        rmSync(cache, { recursive: true, force: true });
    }
});

test("ensureNodeBinary reuses a valid selected node without a network lookup", async () => {
    const cache = scratch();
    const originalCache = process.env.QINIT_CACHE;
    const originalFetch = globalThis.fetch;
    const filename = process.platform === "win32" ? "Qubic.exe" : "Qubic";
    const nodeBinaryPath = join(cache, "qinit-v-cached", "node", filename);
    let requests = 0;

    try {
        process.env.QINIT_CACHE = cache;
        mkdirSync(join(cache, "qinit-v-cached", "node"), { recursive: true });
        writeFileSync(nodeBinaryPath, "node");
        writeFileSync(join(cache, "current.json"), JSON.stringify({ nodeVersion: "qinit-v-cached", node: nodeBinaryPath }));
        globalThis.fetch = (async () => {
            requests++;
            throw new Error("network must not run");
        }) as unknown as typeof fetch;

        expect(await ensureNodeBinary()).toEqual({
            nodeBinaryPath,
            version: "qinit-v-cached",
            cached: true,
        });
        expect(requests).toBe(0);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalCache === undefined) delete process.env.QINIT_CACHE;
        else process.env.QINIT_CACHE = originalCache;
        rmSync(cache, { recursive: true, force: true });
    }
});

test("ensureNodeBinary restores a missing node from the installed headers release", async () => {
    const cache = scratch();
    const originalCache = process.env.QINIT_CACHE;
    const originalFetch = globalThis.fetch;
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const platform = releasePlatformKey();
    const coreHeaders = join(cache, "qinit-v-headers", "core-headers");
    const requests: string[] = [];

    try {
        process.env.QINIT_CACHE = cache;
        mkdirSync(coreHeaders, { recursive: true });
        writeFileSync(join(cache, "current.json"), JSON.stringify({ headersVersion: "qinit-v-headers", coreHeaders }));
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
            const url = String(input);
            requests.push(url);
            if (url.endsWith("qinit-manifest.json")) {
                return Response.json({
                    version: "qinit-v-headers",
                    nodes: { [platform]: { url: "https://example.invalid/node", sha256 } },
                });
            }
            return new Response(bytes, {
                headers: { "content-length": String(bytes.length) },
            });
        }) as unknown as typeof fetch;

        const node = await ensureNodeBinary();
        expect(node.version).toBe("qinit-v-headers");
        expect(node.cached).toBe(false);
        expect(requests[0]).toContain("/download/qinit-v-headers/qinit-manifest.json");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalCache === undefined) delete process.env.QINIT_CACHE;
        else process.env.QINIT_CACHE = originalCache;
        rmSync(cache, { recursive: true, force: true });
    }
});

test("ensureNodeBinary does not pair a downloaded node with local headers", async () => {
    const cache = scratch();
    const originalCache = process.env.QINIT_CACHE;
    const originalFetch = globalThis.fetch;
    const coreHeaders = join(cache, "local-core");
    let requests = 0;

    try {
        process.env.QINIT_CACHE = cache;
        mkdirSync(coreHeaders, { recursive: true });
        writeFileSync(join(cache, "current.json"), JSON.stringify({ headersVersion: "local", coreHeaders }));
        globalThis.fetch = (async () => {
            requests++;
            throw new Error("network must not run");
        }) as unknown as typeof fetch;

        await expect(ensureNodeBinary()).rejects.toThrow("local headers have no matching managed node");

        writeFileSync(join(cache, "current.json"), JSON.stringify({ headersVersion: "cached", coreHeaders }));
        await expect(ensureNodeBinary()).rejects.toThrow("installed headers do not identify a release");
        expect(requests).toBe(0);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalCache === undefined) delete process.env.QINIT_CACHE;
        else process.env.QINIT_CACHE = originalCache;
        rmSync(cache, { recursive: true, force: true });
    }
});

test("an explicit latest node request never falls back to the selected cache", async () => {
    const cache = scratch();
    const originalCache = process.env.QINIT_CACHE;
    const originalFetch = globalThis.fetch;
    const nodeBinaryPath = join(cache, "old", "node", "Qubic");
    const requests: string[] = [];

    try {
        process.env.QINIT_CACHE = cache;
        mkdirSync(join(cache, "old", "node"), { recursive: true });
        writeFileSync(nodeBinaryPath, "old");
        writeFileSync(join(cache, "current.json"), JSON.stringify({ nodeVersion: "old", node: nodeBinaryPath }));
        globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
            requests.push(String(input));
            return new Response("unavailable", { status: 503 });
        }) as unknown as typeof fetch;

        await expect(ensureNodeBinary("latest")).rejects.toThrow("manifest fetch failed");
        expect(requests[0]).toContain("/releases/latest/download/qinit-manifest.json");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalCache === undefined) delete process.env.QINIT_CACHE;
        else process.env.QINIT_CACHE = originalCache;
        rmSync(cache, { recursive: true, force: true });
    }
});

// `launchNode` writes the child's stdout to <scratch>/node.log, so a stand-in binary that echoes its argv proves the args.
const launchedArgs = async (options: Partial<Parameters<typeof launchNode>[0]>): Promise<string> => {
    const dir = scratch();
    const stub = join(dir, "echo-argv.sh");
    writeFileSync(stub, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    // launchNode records the active scratch under the cache root; keep it out of the real cache.
    const previousCache = process.env.QINIT_CACHE;
    process.env.QINIT_CACHE = join(dir, "cache");
    try {
        const launched = launchNode({ nodeBinary: stub, scratchDirectory: join(dir, "run"), ...options });
        for (let i = 0; i < 50 && !readFileSync(launched.log, "utf8").trim(); i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        return readFileSync(launched.log, "utf8").trim();
    } finally {
        if (previousCache === undefined) delete process.env.QINIT_CACHE;
        else process.env.QINIT_CACHE = previousCache;
        rmSync(dir, { recursive: true, force: true });
    }
};

// the stand-in is a `#!/bin/sh` script, which Windows cannot spawn; the argv assembly is platform-independent.
test.skipIf(process.platform === "win32")("launchNode forwards --http-port only when one is given", async () => {
    expect(await launchedArgs({ httpPort: 41941 })).toContain("--http-port 41941");
    expect(await launchedArgs({})).not.toContain("--http-port");
});
