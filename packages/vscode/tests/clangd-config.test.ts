import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateClangdConfig, deriveName, DEFAULT_SLOT } from "../src/clangd-config";

const COUNTER = resolve("fixtures", "Counter.h");
const hasFixture = existsSync(COUNTER);

test("deriveName: basename without extension; explicit override wins", () => {
  expect(deriveName("/a/b/Counter.h")).toBe("Counter");
  expect(deriveName("C:\\proj\\Token.h")).toBe("Token");
  expect(deriveName("/a/b/Counter.h", "MyState")).toBe("MyState");
  expect(deriveName("/a/b/Counter.h", "")).toBe("Counter"); // empty override ignored
});

test.if(hasFixture)("generateClangdConfig: wrapper is genWrapperWasm verbatim; DB mirrors the recipe minus link flags", () => {
  const ws = mkdtempSync(join(tmpdir(), "qpi-cfg-"));
  try {
    const r = generateClangdConfig({
      contractPath: COUNTER,
      corePath: "/fake/core",
      wasiClang: "/fake/wasi/bin/clang++",
      wasiSysroot: "/fake/wasi/sysroot",
      workspaceRoot: ws,
    });

    expect(r.name).toBe("Counter");
    expect(r.slot).toBe(DEFAULT_SLOT);

    // --- the wrapper TU is the wasm build's, not the .so build's ---
    const wrapper = readFileSync(r.wrapperPath, "utf8");
    expect(wrapper).toContain("#define LITE_WASM_TU_BUILD");
    expect(wrapper).toContain('#include "extensions/lite_wasm_tu.h"');
    expect(wrapper).not.toContain("#define LITE_DYN_SO_BUILD");
    expect(wrapper).toContain("#define CONTRACT_STATE_TYPE Counter");
    expect(wrapper).toContain(`#define CONTRACT_INDEX ${DEFAULT_SLOT}`);
    expect(wrapper).toContain('#include "contracts/qpi.h"');
    // the contract is #included by forward-slash absolute path (valid C++ literal on Windows)
    expect(wrapper).toContain('#include "' + COUNTER.replace(/\\/g, "/") + '"');

    // --- compile_commands.json mirrors recipe.ts:compileWasmContract minus codegen/link-only flags ---
    const dbText = readFileSync(r.dbPath, "utf8");
    const db = JSON.parse(dbText);
    expect(db).toHaveLength(1);
    const args: string[] = db[0].arguments;
    expect(args).toContain("--target=wasm32-wasi");
    expect(args).toContain("-std=c++20");
    expect(args).toContain("-DLITEDYN_CONTRACT_TU");
    expect(args).toContain("-fno-rtti");
    expect(args).toContain("-fno-exceptions");
    expect(args).toContain("--sysroot=/fake/wasi/sysroot");
    expect(args).toContain("-I/fake/core");
    expect(args).toContain("-I/fake/core/src");
    expect(args[0]).toBe("/fake/wasi/bin/clang++"); // argv[0] = real driver (query-driver match)
    expect(db[0].file).toBe(r.wrapperPath.replace(/\\/g, "/"));
    // codegen/link-only flags MUST be dropped — clangd can't use them
    expect(args).not.toContain("-O0");
    expect(args).not.toContain("-g");
    expect(args).not.toContain("-o");
    expect(args).not.toContain("-mexec-model=reactor");
    expect(args.some((a) => a.startsWith("-Wl,"))).toBe(false);

    // --- forward slashes everywhere in the DB (clangd requirement on Windows) ---
    expect(dbText.includes("\\")).toBe(false);

    // --- .clangd points clangd at the DB ---
    expect(readFileSync(r.dotClangdPath, "utf8")).toContain("CompilationDatabase: .qinit/clangd");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test.if(hasFixture)("generateClangdConfig: does not clobber a user's existing .clangd", () => {
  const ws = mkdtempSync(join(tmpdir(), "qpi-cfg-"));
  try {
    const dot = join(ws, ".clangd");
    require("node:fs").writeFileSync(dot, "# user owned\n");
    generateClangdConfig({ contractPath: COUNTER, corePath: "/fake/core", wasiClang: "/fake/clang++", workspaceRoot: ws });
    expect(readFileSync(dot, "utf8")).toBe("# user owned\n");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
