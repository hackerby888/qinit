import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  generateClangdConfig,
  deriveName,
  DEFAULT_SLOT,
  ensureEditorSettings,
  detectStateType,
} from "../../src/clangd-config";
import { writeFileSync } from "node:fs";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";

const COUNTER = resolve("fixtures", "Counter.h");
const hasFixture = existsSync(COUNTER);

test("deriveName: basename without extension; explicit override wins", () => {
  expect(deriveName("/a/b/Counter.h")).toBe("Counter");
  expect(deriveName("C:\\proj\\Token.h")).toBe("Token");
  expect(deriveName("/a/b/Counter.h", "MyState")).toBe("MyState");
  expect(deriveName("/a/b/Counter.h", "")).toBe("Counter"); // empty override ignored
});

test("detectStateType reads the `struct <Name> : public ContractBase` from source", () => {
  expect(detectStateType("struct ESCROW : public ContractBase {}")).toBe("ESCROW");
  expect(detectStateType("struct MyToken:public ContractBase{}")).toBe("MyToken");
  expect(detectStateType("struct CONTRACT_STATE_TYPE : public ContractBase {}")).toBe(
    "CONTRACT_STATE_TYPE",
  );
  expect(detectStateType("uint64 x; // no contract here")).toBeUndefined();
});

test("CONTRACT_STATE_TYPE comes from the source struct, not the filename / qinit.json", () => {
  const ws = mkdtempSync(join(tmpdir(), "qpi-name-"));
  try {
    const f = join(ws, "Counter.h");
    writeFileSync(
      f,
      "using namespace QPI;\nstruct Escrow2 {};\nstruct Escrow : public ContractBase { struct StateData { uint64 x; }; };\n",
    );
    const r = generateClangdConfig({
      contractPath: f,
      corePath: "/fake/core",
      workspaceRoot: ws,
      name: "Counter",
    });
    expect(r.name).toBe("Escrow");
    expect(readFileSync(r.prefixPath, "utf8")).toContain("#define CONTRACT_STATE_TYPE Escrow");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test.if(hasFixture)(
  "generateClangdConfig: prefix carries the wrapper preamble; DB parses the contract with it",
  () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-cfg-"));
    try {
      const r = generateClangdConfig({
        contractPath: COUNTER,
        corePath: "/fake/core",
        workspaceRoot: ws,
      });

      expect(r.name).toBe("Counter");
      expect(r.slot).toBe(DEFAULT_SLOT);
      expect(r.restartRequired).toBe(true);

      const prefix = readFileSync(r.prefixPath, "utf8");
      expect(prefix).toContain("#define LITE_WASM_TU_BUILD");
      expect(prefix).toContain("#define CONTRACT_STATE_TYPE Counter");
      expect(prefix).toContain("#define CONTRACT_STATE2_TYPE Counter2");
      expect(prefix).toContain(`#define CONTRACT_INDEX ${DEFAULT_SLOT}`);
      expect(prefix).toContain('#include "contracts/qpi.h"');
      expect(prefix).not.toContain(`#include "${CORE_WASM_HEADERS.sdk.moduleRuntime}"`);
      expect(prefix).not.toContain('#include "' + COUNTER.replace(/\\/g, "/") + '"');

      const dbText = readFileSync(r.dbPath, "utf8");
      const db = JSON.parse(dbText);
      expect(db).toHaveLength(1);
      const args: string[] = db[0].arguments;
      expect(args[0]).toBe("clang++");
      expect(args).toContain("--target=wasm32-wasi");
      expect(args).toContain("-std=c++20");
      expect(args).toContain("-DLITEDYN_CONTRACT_TU");
      expect(args).toContain("-fno-rtti");
      expect(args).toContain("-fno-exceptions");
      expect(args).toContain("-Wno-undefined-inline");
      expect(args).toContain("--sysroot=/fake/core/wasi-sdk/share/wasi-sysroot");
      expect(args).toContain("-isystem");
      expect(args).toContain("/fake/core");
      expect(args).toContain("/fake/core/src");
      expect(args.some((a) => a.startsWith("-I/fake/core"))).toBe(false);
      expect(args).toContain(r.prefixPath.replace(/\\/g, "/"));
      expect(args.slice(-3)).toEqual(["-x", "c++", r.contractFile]);
      expect(db[0].file).toBe(r.contractFile);
      expect(r.contractFile).toBe(COUNTER.replace(/\\/g, "/"));
      expect(args).not.toContain("-O0");
      expect(args).not.toContain("-g");
      expect(args).not.toContain("-o");
      expect(args).not.toContain("-mexec-model=reactor");
      expect(args.some((a) => a.startsWith("-Wl,"))).toBe(false);

      expect(dbText.includes("\\")).toBe(false);

      const dotClangd = readFileSync(r.dotClangdPath, "utf8");
      expect(dotClangd).toContain(join(ws, ".qpi", "clangd").replace(/\\/g, "/"));
      expect(dotClangd).toContain("AllScopes: No");
      expect(dotClangd).toContain("HeaderInsertion: Never");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);

test.if(hasFixture)("generateClangdConfig: does not clobber a user's existing .clangd", () => {
  const ws = mkdtempSync(join(tmpdir(), "qpi-cfg-"));
  try {
    const dot = join(ws, ".clangd");
    require("node:fs").writeFileSync(dot, "# user owned\n");
    generateClangdConfig({
      contractPath: COUNTER,
      corePath: "/fake/core",
      workspaceRoot: ws,
    });
    expect(readFileSync(dot, "utf8")).toBe("# user owned\n");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test.if(hasFixture)(
  "multi-contract: a second contract adds a second DB entry; regen doesn't duplicate",
  () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-multi-"));
    try {
      const base = { corePath: "/fake/core", workspaceRoot: ws };
      const TOKEN = resolve("fixtures", "Token.h");
      const expected = existsSync(TOKEN) ? 2 : 1;
      generateClangdConfig({ ...base, contractPath: COUNTER });
      if (existsSync(TOKEN)) generateClangdConfig({ ...base, contractPath: TOKEN });
      const dbPath = join(ws, ".qpi", "clangd", "compile_commands.json");
      expect(JSON.parse(readFileSync(dbPath, "utf8")).length).toBe(expected);
      const regenerated = generateClangdConfig({ ...base, contractPath: COUNTER });
      expect(JSON.parse(readFileSync(dbPath, "utf8")).length).toBe(expected); // not duplicated
      expect(regenerated.restartRequired).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);

test.if(hasFixture)(
  "ensureEditorSettings disables cpptools IntelliSense, but respects an existing choice",
  () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-set-"));
    try {
      generateClangdConfig({
        contractPath: COUNTER,
        corePath: "/fake/core",
        workspaceRoot: ws,
      });
      const s = JSON.parse(readFileSync(join(ws, ".vscode", "settings.json"), "utf8"));
      expect(s["C_Cpp.intelliSenseEngine"]).toBe("disabled");
      expect(s["C_Cpp.errorSquiggles"]).toBe("disabled");
      const ws2 = mkdtempSync(join(tmpdir(), "qpi-set2-"));
      try {
        const fs = require("node:fs");
        fs.mkdirSync(join(ws2, ".vscode"));
        fs.writeFileSync(
          join(ws2, ".vscode", "settings.json"),
          JSON.stringify({ "C_Cpp.intelliSenseEngine": "default" }),
        );
        ensureEditorSettings(ws2);
        expect(
          JSON.parse(readFileSync(join(ws2, ".vscode", "settings.json"), "utf8"))[
            "C_Cpp.intelliSenseEngine"
          ],
        ).toBe("default");
      } finally {
        rmSync(ws2, { recursive: true, force: true });
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  },
);
