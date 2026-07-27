import { test, expect, afterEach } from "bun:test";
import {
  DEFAULT_PEER_PORT,
  DEFAULT_RPC_BASE,
  DEFAULT_RPC_PORT,
  LOOPBACK_HOST,
  fetchT,
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
  expect(DEFAULT_PEER_PORT).toBe(21841);
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

test("fetchT: aborts a hung connection after the timeout", async () => {
  // a fetch that never resolves on its own but honors the abort signal (the real hang scenario)
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
    })) as any;
  await expect(fetchT("http://node", undefined, 50)).rejects.toThrow(/timed out after 50ms/);
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
