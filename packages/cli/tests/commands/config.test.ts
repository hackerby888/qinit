// Project config, global seed/theme stores and resolution precedence: a bug here silently signs with the wrong seed or builds against the wrong core.
import { test, expect, afterEach } from "bun:test";
import { DEFAULT_FUNDED_SEED, DEFAULT_RPC_BASE } from "@qinit/core";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertLoopbackRpc,
    loadConfig,
    resolveRpc,
    seedStorePath,
    savedSeed,
    setSavedSeed,
    clearSavedSeed,
    savedTheme,
    setSavedTheme,
    savedRuntime,
    setSavedRuntime,
    runtimeStorePath,
    resolveRuntime,
    savedCompilerBackend,
    setSavedCompilerBackend,
    compilerBackendStorePath,
    resolveCompilerBackend,
    resolveSeed,
    resolveCoreDir,
} from "../../src/config";

const saved = {
    xdg: process.env.XDG_CONFIG_HOME,
    cache: process.env.QINIT_CACHE,
    core: process.env.QINIT_CORE,
};
const dirs: string[] = [];
function isolate() {
    const x = mkdtempSync(join(tmpdir(), "qinit-cfg-"));
    dirs.push(x);
    process.env.XDG_CONFIG_HOME = x;
    process.env.QINIT_CACHE = join(x, "cache");
    delete process.env.QINIT_CORE;
    return x;
}
afterEach(() => {
    for (const k of ["XDG_CONFIG_HOME", "QINIT_CACHE", "QINIT_CORE"] as const) {
        const v = saved[k === "XDG_CONFIG_HOME" ? "xdg" : k === "QINIT_CACHE" ? "cache" : "core"];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("loadConfig: missing -> {}, valid -> parsed, malformed -> throws", () => {
    const x = isolate();
    expect(loadConfig(join(x, "nope.json"))).toEqual({});
    const good = join(x, "good.json");
    writeFileSync(good, JSON.stringify({ contractName: "C", slot: 28 }));
    expect(loadConfig(good)).toEqual({ contractName: "C", slot: 28 });
    const bad = join(x, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => loadConfig(bad)).toThrow(/could not be read/);
});

test("loadConfig: a UTF-8 BOM does not discard the config", () => {
    const x = isolate();
    const bom = join(x, "bom.json");
    writeFileSync(bom, "\ufeff" + JSON.stringify({ contractName: "MyToken", contract: "contracts/MyToken.h" }));
    expect(loadConfig(bom)).toEqual({ contractName: "MyToken", contract: "contracts/MyToken.h" });
});

test("seed store: round-trip, reject bad seed, ignore corrupt, clear", () => {
    isolate();
    expect(savedSeed()).toBeUndefined();
    const SEED = "b".repeat(55);
    setSavedSeed(SEED);
    expect(savedSeed()).toBe(SEED);
    expect(() => setSavedSeed("too-short")).toThrow(/invalid seed/);
    writeFileSync(seedStorePath(), "GARBAGE"); // corrupt value -> savedSeed rejects it
    expect(savedSeed()).toBeUndefined();
    clearSavedSeed();
    expect(existsSync(seedStorePath())).toBe(false);
});

test("theme store: round-trip", () => {
    isolate();
    expect(savedTheme()).toBeUndefined();
    setSavedTheme("dracula");
    expect(savedTheme()).toBe("dracula");
});

test("runtime store: default undefined, round-trip, ignore unknown value", () => {
    const configRoot = isolate();
    expect(savedRuntime()).toBeUndefined();
    expect(resolveRuntime()).toBe("core");
    setSavedRuntime("simulator");
    writeFileSync(join(configRoot, "qinit", "node-backend"), "core\n");
    expect(savedRuntime()).toBe("simulator");
    expect(resolveRuntime()).toBe("simulator");
    expect(resolveRuntime("core")).toBe("core");
    writeFileSync(runtimeStorePath(), "bogus");
    expect(savedRuntime()).toBeUndefined();
    expect(() => resolveRuntime("bogus")).toThrow("--runtime must be core or simulator");
});

test("compiler backend store: default undefined, round-trip, ignore unknown value", () => {
    isolate();
    expect(savedCompilerBackend()).toBeUndefined();
    expect(resolveCompilerBackend()).toBe("clang");
    setSavedCompilerBackend("typescript");
    expect(savedCompilerBackend()).toBe("typescript");
    expect(resolveCompilerBackend()).toBe("typescript");
    expect(resolveCompilerBackend("clang")).toBe("clang");
    writeFileSync(compilerBackendStorePath(), "bogus");
    expect(savedCompilerBackend()).toBeUndefined();
    expect(() => resolveCompilerBackend("bogus")).toThrow("--compiler must be clang or typescript");
});

test("resolveSeed precedence: explicit > saved > funded > default", async () => {
    isolate();
    const withFunded = { fundedSeed: async () => "f".repeat(55) };
    const noFunded = { fundedSeed: async () => undefined };
    expect(await resolveSeed(withFunded, "c".repeat(55))).toBe("c".repeat(55)); // explicit wins
    await expect(resolveSeed(withFunded, "bad")).rejects.toThrow(/invalid seed/); // explicit validated
    setSavedSeed("d".repeat(55));
    expect(await resolveSeed(withFunded)).toBe("d".repeat(55)); // saved over funded
    clearSavedSeed();
    expect(await resolveSeed(withFunded)).toBe("f".repeat(55)); // funded over default
    expect(await resolveSeed(noFunded)).toBe(DEFAULT_FUNDED_SEED); // dev default, funded on both runtimes
});

test("resolveCoreDir: explicit precedence -> absolute; throws when unresolved", () => {
    const x = isolate();
    expect(resolveCoreDir(join(x, "cli-core"))).toBe(join(x, "cli-core"));
    expect(resolveCoreDir(undefined, join(x, "cfg-core"))).toBe(join(x, "cfg-core"));
    process.env.QINIT_CORE = join(x, "env-core");
    expect(resolveCoreDir()).toBe(join(x, "env-core"));
    delete process.env.QINIT_CORE;
    expect(() => resolveCoreDir()).toThrow(/no core headers/);
});

// every node-facing command resolves the rpc the same way, or `node run` starts one node while `deploy` talks to another.
test("resolveRpc precedence: --rpc > qinit.json rpc > default", () => {
    expect(resolveRpc("http://127.0.0.1:47241", { rpc: "http://127.0.0.1:5" })).toBe("http://127.0.0.1:47241");
    expect(resolveRpc(undefined, { rpc: "http://127.0.0.1:5" })).toBe("http://127.0.0.1:5");
    expect(resolveRpc("", { rpc: "http://127.0.0.1:5" })).toBe("http://127.0.0.1:5");
    expect(resolveRpc(undefined, {})).toBe(DEFAULT_RPC_BASE);
});

test("assertLoopbackRpc: a local node binds loopback only", () => {
    for (const rpc of ["http://127.0.0.1:41841", "http://localhost:41841", "http://[::1]:41841"]) {
        expect(() => assertLoopbackRpc(rpc)).not.toThrow();
    }
    expect(() => assertLoopbackRpc("http://10.0.0.1:41841")).toThrow(
        "qinit.json rpc is http://10.0.0.1:41841 — a local node needs a loopback address, pass --rpc",
    );
});

test("no command resolves the rpc on its own", () => {
    const commandsDir = join(import.meta.dir, "../../src/commands");
    const offenders = readdirSync(commandsDir, { recursive: true })
        .map(String)
        .filter((file) => /\.tsx?$/.test(file))
        .filter((file) => /get\("rpc"\)\s*(\|\||\?\?)/.test(readFileSync(join(commandsDir, file), "utf8")));
    expect(offenders).toEqual([]);
});
