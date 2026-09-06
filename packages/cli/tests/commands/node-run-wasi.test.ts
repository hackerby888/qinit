import { test, expect } from "bun:test";
import { prepareNodeRunWasiSdk, type NodeRunWasiDeps } from "../../src/ops/node-wasi";

function deps(overrides: Partial<NodeRunWasiDeps> = {}) {
    let fetches = 0;
    const d: NodeRunWasiDeps = {
        configuredWasiSdk: () => null,
        haveWasiSdkCache: () => false,
        fetchWasiSdk: async () => {
            fetches += 1;
            return { dir: "/cache/wasi-sdk", cached: false };
        },
        ...overrides,
    };
    return { d, fetches: () => fetches };
}

test("an SDK configured through WASM_CLANG/WASI_SYSROOT is reused without any download", async () => {
    const { d, fetches } = deps({ configuredWasiSdk: () => "/opt/wasi-sdk" });
    expect(await prepareNodeRunWasiSdk({ offline: false }, d)).toEqual({ state: "configured", detail: "ready /opt/wasi-sdk" });
    expect(fetches()).toBe(0);
});

test("a managed cache is reused without any download", async () => {
    const { d, fetches } = deps({ haveWasiSdkCache: () => true });
    expect((await prepareNodeRunWasiSdk({ offline: false }, d)).state).toBe("cached");
    expect(fetches()).toBe(0);
});

test("with nothing configured or cached the SDK is fetched once", async () => {
    const { d, fetches } = deps();
    expect((await prepareNodeRunWasiSdk({ offline: false }, d)).state).toBe("fetched");
    expect(fetches()).toBe(1);
});

test("offline skips the fetch instead of failing", async () => {
    const { d, fetches } = deps();
    expect(await prepareNodeRunWasiSdk({ offline: true }, d)).toEqual({ state: "skipped", detail: "offline — skipped" });
    expect(fetches()).toBe(0);
});

test("a failed fetch is reported as unavailable with the env hint", async () => {
    const { d } = deps({
        fetchWasiSdk: async () => {
            throw new Error("socket closed");
        },
    });
    const r = await prepareNodeRunWasiSdk({ offline: false }, d);
    expect(r.state).toBe("unavailable");
    expect(r.detail).toContain("WASM_CLANG/WASI_SYSROOT");
});
