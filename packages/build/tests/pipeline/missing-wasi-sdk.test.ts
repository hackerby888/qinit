// with no wasi-sdk the build used to try a host clang++ with no sysroot, which fails with a compiler error that never mentions setup.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWasmContract } from "../../src/compile/clang";

test("a clang build with no wasi-sdk anywhere refuses and names qinit setup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-no-wasi-sdk-"));
    const saved = { QINIT_CACHE: process.env.QINIT_CACHE, WASM_CLANG: process.env.WASM_CLANG, WASI_SYSROOT: process.env.WASI_SYSROOT };
    process.env.QINIT_CACHE = join(directory, "cache");
    delete process.env.WASM_CLANG;
    delete process.env.WASI_SYSROOT;
    try {
        const outDir = join(directory, "out");
        const result = await compileWasmContract({ contractPath: join(directory, "C.h"), contractName: "C", slot: 28, corePath: directory, outDir });

        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("run `qinit setup`");
        expect(existsSync(result.wrapper)).toBe(false);
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        rmSync(directory, { recursive: true, force: true });
    }
});
