import { test, expect, afterEach } from "bun:test";
import { fetchT, LiteRpc } from "../../src/index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

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
