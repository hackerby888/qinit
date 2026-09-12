import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateClangdConfig, generateTestClangdConfig, deriveName, DEFAULT_SLOT, ensureEditorSettings, detectStateType } from "../../src/clangd-config";
import { writeFileSync } from "node:fs";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm/headers";
import { generateWasmWrapperSource } from "@qinit/build/compile/clang";
import { CheatMode } from "@qinit/compiler";

const COUNTER = resolve("fixtures", "Counter.h");
const hasFixture = existsSync(COUNTER);
const CORE = process.env.QINIT_CORE ?? "";
const QUTIL_TEST = join(CORE, "test", "contract_qutil.cpp");

test("deriveName: basename without extension; explicit override wins", () => {
    expect(deriveName("/a/b/Counter.h")).toBe("Counter");
    expect(deriveName("C:\\proj\\Token.h")).toBe("Token");
    expect(deriveName("/a/b/Counter.h", "MyState")).toBe("MyState");
    expect(deriveName("/a/b/Counter.h", "")).toBe("Counter"); // empty override ignored
});

test("detectStateType reads the `struct <Name> : public ContractBase` from source", () => {
    expect(detectStateType("struct ESCROW : public ContractBase {}")).toBe("ESCROW");
    expect(detectStateType("struct MyToken:public ContractBase{}")).toBe("MyToken");
    expect(detectStateType("struct CONTRACT_STATE_TYPE : public ContractBase {}")).toBe("CONTRACT_STATE_TYPE");
    expect(detectStateType("uint64 x; // no contract here")).toBeUndefined();
});

test("CONTRACT_STATE_TYPE comes from the source struct, not the filename / qinit.json", () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-name-"));
    try {
        const f = join(ws, "Counter.h");
        writeFileSync(f, "using namespace QPI;\nstruct Escrow2 {};\nstruct Escrow : public ContractBase { struct StateData { uint64 x; }; };\n");
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

test.if(hasFixture)("generateClangdConfig: prefix carries the wrapper preamble; DB parses the contract with it", () => {
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
        expect(prefix).toContain('#include "qpi/qpi.h"');
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

        // the database goes where clangd auto-discovers it, so `.clangd` carries the settings alone.
        expect(r.dbPath).toBe(join(ws, "compile_commands.json"));
        const dotClangd = readFileSync(join(ws, ".clangd"), "utf8");
        expect(dotClangd).not.toContain("CompilationDatabase");
        expect(dotClangd).toContain("AllScopes: No");
        expect(dotClangd).toContain("HeaderInsertion: Never");
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

test.if(hasFixture && existsSync(QUTIL_TEST))("generateTestClangdConfig uses the selected core contract catalog", () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-test-cfg-"));
    try {
        generateTestClangdConfig({
            contractPath: COUNTER,
            corePath: CORE,
            workspaceRoot: ws,
            slot: 100,
            testPath: QUTIL_TEST,
        });

        const header = readFileSync(join(ws, ".qpi", "clangd", "contract_testing.h"), "utf8");
        expect(header).toContain('{"QX", 66, 10000, 0}');
        expect(header).toContain('{"Counter", 0, 10000, 0}');
        expect(header).toContain("contractCount = 101;");
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

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

test.if(hasFixture)("multi-contract: a second contract adds a second DB entry; regen doesn't duplicate", () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-multi-"));
    try {
        const base = { corePath: "/fake/core", workspaceRoot: ws };
        const TOKEN = resolve("fixtures", "Token.h");
        const expected = existsSync(TOKEN) ? 2 : 1;
        generateClangdConfig({ ...base, contractPath: COUNTER });
        if (existsSync(TOKEN)) generateClangdConfig({ ...base, contractPath: TOKEN });
        const dbPath = join(ws, "compile_commands.json");
        expect(JSON.parse(readFileSync(dbPath, "utf8")).length).toBe(expected);
        const regenerated = generateClangdConfig({ ...base, contractPath: COUNTER });
        expect(JSON.parse(readFileSync(dbPath, "utf8")).length).toBe(expected); // not duplicated
        expect(regenerated.restartRequired).toBe(false);
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

test.if(hasFixture)("ensureEditorSettings disables cpptools IntelliSense, but respects an existing choice", () => {
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
            fs.writeFileSync(join(ws2, ".vscode", "settings.json"), JSON.stringify({ "C_Cpp.intelliSenseEngine": "default" }));
            ensureEditorSettings(ws2);
            expect(JSON.parse(readFileSync(join(ws2, ".vscode", "settings.json"), "utf8"))["C_Cpp.intelliSenseEngine"]).toBe("default");
        } finally {
            rmSync(ws2, { recursive: true, force: true });
        }
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

test("the clangd prefix header carries the cheatcodes, so the editor resolves them", () => {
    // clangd sees the wrapper sliced at the contract include, so the shim goes before it — that is what makes CC_* resolve with no extension-side declaration.
    const wrapper = generateWasmWrapperSource({
        contractPath: "/tmp/Cheats.h",
        contractName: "Cheats",
        slot: 28,
        corePath: "/tmp/core",
        outDir: "/tmp/out",
    });
    const prefix = wrapper.slice(0, wrapper.indexOf('#include "/tmp/Cheats.h"'));

    expect(prefix).toContain("#define CC_PRINT(...)");
    expect(prefix).toContain("#define CC_ASSERT(c)");
});

test("a production wrapper defines no cheatcodes at all", () => {
    const wrapper = generateWasmWrapperSource({
        contractPath: "/tmp/Cheats.h",
        contractName: "Cheats",
        slot: 28,
        corePath: "/tmp/core",
        outDir: "/tmp/out",
        cheats: CheatMode.OFF,
    });

    expect(wrapper).not.toContain("CC_PRINT");
});

test.if(hasFixture)("a foreign root database is not overwritten, and the fallback pointer is relative", () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-foreign-"));
    try {
        const foreign = [{ directory: "/somewhere/else", file: "/somewhere/else/main.cpp", arguments: ["clang++", "main.cpp"] }];
        writeFileSync(join(ws, "compile_commands.json"), JSON.stringify(foreign));

        const r = generateClangdConfig({ corePath: "/fake/core", workspaceRoot: ws, contractPath: COUNTER });

        expect(JSON.parse(readFileSync(join(ws, "compile_commands.json"), "utf8"))).toEqual(foreign);
        // clangd rejects the whole database on an unknown key, so provenance is a marker file, not an entry field.
        expect(Object.keys(JSON.parse(readFileSync(r.dbPath, "utf8"))[0]).sort()).toEqual(["arguments", "directory", "file"]);
        expect(r.dbPath).toBe(join(ws, ".qpi", "clangd", "compile_commands.json"));

        const dotClangd = readFileSync(join(ws, ".clangd"), "utf8");
        expect(dotClangd).toContain('CompilationDatabase: ".qpi/clangd"');
        expect(dotClangd).not.toContain(ws); // no absolute path: it has to survive a clone
        expect(dotClangd).toContain("AllScopes: No");
        expect(dotClangd).toContain("HeaderInsertion: Never");
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

test.if(hasFixture)("a stale generated .clangd is rewritten and forces a restart; a hand-written one is left alone", () => {
    const ws = mkdtempSync(join(tmpdir(), "qpi-stale-"));
    try {
        writeFileSync(join(ws, "compile_commands.json"), JSON.stringify([{ directory: "/elsewhere", file: "x.cpp", arguments: [] }]));
        writeFileSync(join(ws, ".clangd"), '# Generated by the Qubic QPI extension.\nCompileFlags:\n  CompilationDatabase: "/home/someone-else/profile/abc"\n');

        const r = generateClangdConfig({ corePath: "/fake/core", workspaceRoot: ws, contractPath: COUNTER });
        expect(readFileSync(join(ws, ".clangd"), "utf8")).toContain('CompilationDatabase: ".qpi/clangd"');
        expect(r.restartRequired).toBe(true);

        const mine = "CompileFlags:\n  CompilationDatabase: build\n";
        writeFileSync(join(ws, ".clangd"), mine);
        generateClangdConfig({ corePath: "/fake/core", workspaceRoot: ws, contractPath: COUNTER });
        expect(readFileSync(join(ws, ".clangd"), "utf8")).toBe(mine);
    } finally {
        rmSync(ws, { recursive: true, force: true });
    }
});

// The extension rewrites the developer's workspace root, so every way that root can already be occupied is a
// way to destroy their setup. Each case asserts what it writes and what it keeps its hands off.
test.if(hasFixture)("a root the developer already occupies is worked around, never clobbered", () => {
    const mine = "Diagnostics:\n  ClangTidy:\n    Add: modernize*\n";
    const theirDb = (dir: string) => JSON.stringify([{ directory: dir, file: "other.cpp", arguments: ["clang++"] }]);

    const run = (setup: (dir: string) => void) => {
        const ws = mkdtempSync(join(tmpdir(), "qpi-degraded-"));
        setup(ws);
        const result = generateClangdConfig({ corePath: "/fake/core", workspaceRoot: ws, contractPath: COUNTER });
        const dotClangd = readFileSync(join(ws, ".clangd"), "utf8");
        rmSync(ws, { recursive: true, force: true });
        return { result, dotClangd, relocated: result.dbPath.includes(".qpi") };
    };

    // A free root: the database lands there and needs no pointer, because clangd discovers it itself.
    const pristine = run(() => {});
    expect(pristine.relocated).toBe(false);
    expect(pristine.result.clangdConfigured).toBe(true);
    expect(pristine.dotClangd).not.toContain("CompilationDatabase");

    // A hand-written .clangd survives untouched, and the database still reaches the root beside it.
    const ownedConfig = run((dir) => writeFileSync(join(dir, ".clangd"), mine));
    expect(ownedConfig.dotClangd).toBe(mine);
    expect(ownedConfig.relocated).toBe(false);
    expect(ownedConfig.result.clangdConfigured).toBe(true);

    // Someone else's database at the root pushes ours aside, and .clangd is rewritten to name it.
    const ownedDb = run((dir) => writeFileSync(join(dir, "compile_commands.json"), theirDb(dir)));
    expect(ownedDb.relocated).toBe(true);
    expect(ownedDb.dotClangd).toContain('CompilationDatabase: ".qpi/clangd"');

    // Both occupied: nothing of theirs is touched and the result says so, rather than pretending.
    const ownedBoth = run((dir) => {
        writeFileSync(join(dir, ".clangd"), mine);
        writeFileSync(join(dir, "compile_commands.json"), theirDb(dir));
    });
    expect(ownedBoth.dotClangd).toBe(mine);
    expect(ownedBoth.relocated).toBe(true);
    expect(ownedBoth.result.clangdConfigured).toBe(false);

    // A database we cannot parse is someone else's by definition — never overwritten in place.
    for (const unreadable of ["{ not json", '{"a":1}']) {
        const odd = run((dir) => writeFileSync(join(dir, "compile_commands.json"), unreadable));
        expect(odd.relocated).toBe(true);
    }

    // An ownership marker naming a path from some other checkout does not license a clobber either.
    const staleMarker = run((dir) => {
        mkdirSync(join(dir, ".qpi", "clangd"), { recursive: true });
        writeFileSync(join(dir, ".qpi", "clangd", "owns-root-db"), "/some/other/checkout/compile_commands.json");
        writeFileSync(join(dir, "compile_commands.json"), theirDb(dir));
    });
    expect(staleMarker.relocated).toBe(true);
});
