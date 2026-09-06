import { configuredWasiSdk, fetchWasiSdk, haveWasiSdkCache } from "@qinit/core";

const defaultDeps = { configuredWasiSdk, fetchWasiSdk, haveWasiSdkCache };

export type NodeRunWasiDeps = typeof defaultDeps;

export interface NodeRunWasiOptions {
    offline: boolean;
    onProgress?: (received: number, total: number) => void;
}

export type NodeRunWasiState = "configured" | "cached" | "fetched" | "skipped" | "unavailable";

// The wasi-sdk step of `node run`: an SDK the developer configured wins outright, so it is never re-downloaded (F65).
export async function prepareNodeRunWasiSdk(options: NodeRunWasiOptions, deps: NodeRunWasiDeps = defaultDeps): Promise<{ state: NodeRunWasiState; detail: string }> {
    const configured = deps.configuredWasiSdk();
    if (configured) {
        return { state: "configured", detail: `ready ${configured}` };
    }
    if (deps.haveWasiSdkCache()) {
        return { state: "cached", detail: "cached" };
    }
    if (options.offline) {
        return { state: "skipped", detail: "offline — skipped" };
    }
    try {
        const sdk = await deps.fetchWasiSdk(options.onProgress);
        return { state: sdk.cached ? "cached" : "fetched", detail: sdk.cached ? "cached" : "fetched" };
    } catch {
        return { state: "unavailable", detail: "unavailable — set WASM_CLANG/WASI_SYSROOT" };
    }
}
