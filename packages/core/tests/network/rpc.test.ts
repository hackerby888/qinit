import { test, expect, afterEach } from "bun:test";
import {
    DEFAULT_PEER_PORT,
    DEFAULT_RPC_BASE,
    DEFAULT_RPC_PORT,
    LOOPBACK_HOST,
    fetchWithTimeout,
    LiteRpc,
} from "../../src/index";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

test("local network defaults remain compatible with core-lite", () => {
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
    expect(DEFAULT_RPC_PORT).toBe(41841);
    expect(DEFAULT_RPC_BASE).toBe("http://127.0.0.1:41841");
    expect(DEFAULT_PEER_PORT).toBe(31841);
});

test("LiteRpc uses the shared default endpoint", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return json({ tick: 5, epoch: 1 });
    }) as typeof fetch;

    await new LiteRpc().tickInfo();
    expect(requestedUrl).toBe(`${DEFAULT_RPC_BASE}/tick-info`);
});

test("LiteRpc.whoami reads the backend identity endpoint", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return json({ backend: "simulator" });
    }) as typeof fetch;

    expect(await new LiteRpc("http://node").whoami()).toEqual({
        backend: "simulator",
    });
    expect(requestedUrl).toBe("http://node/live/v1/whoami");
});

test("LiteRpc.whoami reports an actionable old-node error", async () => {
    globalThis.fetch = (async () => json({}, 404)) as unknown as typeof fetch;

    await expect(new LiteRpc("http://node").whoami()).rejects.toThrow(
        "upgrade core-lite or the Qinit simulator",
    );
});

test("LiteRpc.directDeploy marks dynamic and system deployments", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ ok: true, slot: bodies.length, digest: "00" });
    }) as typeof fetch;

    const rpc = new LiteRpc("http://node");
    await rpc.directDeploy(29, new Uint8Array([1]), "Counter");
    await rpc.directDeploy(1, new Uint8Array([2]), "QX", "system");

    expect(bodies).toEqual([
        {
            slot: 29,
            name: "Counter",
            kind: "dynamic",
            wasm: "AQ==",
        },
        {
            slot: 1,
            name: "QX",
            kind: "system",
            wasm: "Ag==",
        },
    ]);
});

test("fetchWithTimeout: aborts a hung connection after the timeout", async () => {
    // a fetch that never resolves on its own but honors the abort signal (the real hang scenario)
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () =>
                rej(new DOMException("aborted", "AbortError")),
            );
        })) as any;
    await expect(fetchWithTimeout("http://node", undefined, 50)).rejects.toThrow(
        /timed out after 50ms/,
    );
});

test("LiteRpc.get: retries a transient connect failure, then succeeds", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
        n++;
        if (n < 3) throw new Error("ECONNREFUSED");
        return json({ tick: 5, epoch: 1 });
    }) as any;
    const ti = await new LiteRpc("http://node").tickInfo();
    expect(ti.tick).toBe(5);
    expect(n).toBe(3); // failed twice, succeeded on the 3rd
});

test("LiteRpc.get: exhausts retries -> 'node unreachable'", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
        n++;
        throw new Error("boom");
    }) as any;
    await expect(new LiteRpc("http://node").tickInfo()).rejects.toThrow(/node unreachable/);
    expect(n).toBe(3);
});

test("LiteRpc.get: an HTTP error is a real answer -> NOT retried", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
        n++;
        return json({ err: 1 }, 500);
    }) as any;
    await expect(new LiteRpc("http://node").tickInfo()).rejects.toThrow(/HTTP 500/);
    expect(n).toBe(1);
});
