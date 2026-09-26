// a cached system wasm is only reusable under the compile profile that produced it: an older profile's layouts would seed the wrong state size.
import { expect, test } from "bun:test";
import { cacheRoot } from "@qinit/core";
import { join } from "node:path";
import { systemWasmCacheDir, WASM_BUILD_PROFILE } from "../../src/contracts/system-wasm";

test("the system wasm cache is keyed by headers version, build profile and compiler", () => {
    expect(systemWasmCacheDir("clang", "v7")).toBe(join(cacheRoot(), "v7", "system-wasm", WASM_BUILD_PROFILE, "clang"));
    expect(systemWasmCacheDir("typescript", "v7")).not.toBe(systemWasmCacheDir("clang", "v7"));
});
