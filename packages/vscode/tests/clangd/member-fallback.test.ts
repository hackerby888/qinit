import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateClangdConfig } from "../../src/clangd-config";
import {
  compileEntryFor,
  completionRunsForTests,
  ensurePrefixPch,
  findClang,
  memberFallbackCompletions,
  parseCompletions,
  pchPathFor,
  pchSourcePathFor,
  splitCompileArgs,
} from "../../src/member-fallback";

const BUNDLED_CORE =
  process.env.QPI_VSCODE_HEADERS ??
  resolve(import.meta.dir, "..", "..", "resources", "core-headers");
const hasHeaders = existsSync(join(BUNDLED_CORE, "src", "qpi", "qpi.h"));
const hasClang = (() => {
  for (const candidate of [process.env.WASM_CLANG, "clang++"]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return true;
    } catch {}
  }
  return false;
})();

// Captured from `clang++ -Xclang -code-completion-at` on the CrossCall repro and on an Array member.
const CLANG_OUTPUT = `COMPLETION: a : [#sint16#]a
COMPLETION: bc : [#Array<uint64, 8>#]bc
COMPLETION: Get_input : Get_input::
COMPLETION: operator= : [#Get_input &#]operator=(<#const Get_input &#>)
COMPLETION: ~Get_input : [#void#]~Get_input()
COMPLETION: _values (Inaccessible) : [#unsigned long long[8]#]_values
COMPLETION: capacity : [#uint64#]capacity()
COMPLETION: get : [#const unsigned long long &#]get(<#uint64 index#>)[# const#]
COMPLETION: setRange : [#void#]setRange(<#uint64 indexBegin#>, <#uint64 indexEnd#>, {#const unsigned long long &value#})
COMPLETION: Pattern : static_cast<<#type#>>(<#expression#>)
`;

test("parseCompletions drops patterns, injected class names and unreachable members", () => {
  const names = parseCompletions(CLANG_OUTPUT).map((item) => item.name);

  expect(names).toContain("a");
  expect(names).toContain("bc");
  expect(names).not.toContain("Pattern");
  // `Get_input : Get_input::` is the injected class name, and an inaccessible member is not writable.
  expect(names).not.toContain("Get_input");
  expect(names.some((name) => name.includes("_values"))).toBe(false);
});

test("parseCompletions reads types and tells fields from methods", () => {
  const byName = new Map(parseCompletions(CLANG_OUTPUT).map((item) => [item.name, item]));

  expect(byName.get("bc")?.kind).toBe("field");
  expect(byName.get("bc")?.returnType).toBe("Array<uint64, 8>");
  expect(byName.get("bc")?.placeholders).toEqual([]);
  expect(byName.get("a")?.returnType).toBe("sint16");
  expect(byName.get("capacity")?.kind).toBe("method");
  expect(byName.get("capacity")?.placeholders).toEqual([]);
});

test("parseCompletions reads parameters, qualifiers and skips default arguments", () => {
  const byName = new Map(parseCompletions(CLANG_OUTPUT).map((item) => [item.name, item]));

  expect(byName.get("get")?.placeholders).toEqual(["uint64 index"]);
  expect(byName.get("get")?.returnType).toBe("const unsigned long long &");
  expect(byName.get("get")?.qualifiers).toBe("const");
  // The `{#...#}` chunk is a default argument, which the author never types.
  expect(byName.get("setRange")?.placeholders).toEqual(["uint64 indexBegin", "uint64 indexEnd"]);
  expect(byName.get("setRange")?.qualifiers).toBeUndefined();
});

test("parseCompletions of empty or unrelated output yields nothing", () => {
  expect(parseCompletions("")).toEqual([]);
  expect(parseCompletions("warning: something\nerror: else\n")).toEqual([]);
});

const DB_ARGS = [
  "clang++",
  "--target=wasm32-wasi",
  "-std=c++20",
  "-include",
  "/core/src/extensions/wasm/sdk/platform_intrinsics.h",
  "--sysroot=/sysroot",
  "-isystem",
  "/core",
  "-include",
  "/db/CrossCall.prefix.h",
  "-x",
  "c++",
  "/ws/contracts/CrossCall.h",
];

test("splitCompileArgs drops the prefix include, -x pair and the file operand", () => {
  const split = splitCompileArgs(DB_ARGS, "/db/CrossCall.prefix.h");

  expect(split).toBeDefined();
  expect(split!.shared).toEqual([
    "--target=wasm32-wasi",
    "-std=c++20",
    "-include",
    "/core/src/extensions/wasm/sdk/platform_intrinsics.h",
    "--sysroot=/sysroot",
    "-isystem",
    "/core",
  ]);
});

test("splitCompileArgs refuses an entry that never included the prefix", () => {
  expect(splitCompileArgs(DB_ARGS, "/db/Other.prefix.h")).toBeUndefined();
});

test("compileEntryFor finds the entry recorded next to the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "qpi-fallback-db-"));
  try {
    const prefixPath = join(dir, "CrossCall.prefix.h");
    writeFileSync(
      join(dir, "compile_commands.json"),
      JSON.stringify([{ directory: dir, file: "/ws/contracts/CrossCall.h", arguments: DB_ARGS }]),
    );

    expect(compileEntryFor(prefixPath, "/ws/contracts/CrossCall.h")?.args).toEqual(DB_ARGS);
    expect(compileEntryFor(prefixPath, "/ws/contracts/Other.h")).toBeUndefined();
    expect(compileEntryFor(join(dir, "missing", "x.prefix.h"), "/ws/x.h")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pchPathFor sits beside the prefix", () => {
  expect(pchPathFor("/db/CrossCall.prefix.h")).toBe("/db/CrossCall.prefix.pch");
});

// The user-reported repro: callee input struct with an Array member, completed through locals.
const COUNTER_SOURCE = `using namespace QPI;

struct Counter : public ContractBase {
  struct StateData { uint64 counter; };
  struct Get_input {
    Array<uint64, 8> bc;
    sint16 a;
  };
  struct Get_output { uint64 value; };

  PUBLIC_FUNCTION(Get) {
    output.value = state.get().counter;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
  }
};
`;

const CROSSCALL_SOURCE = `using namespace QPI;

struct CrossCall : public ContractBase {
  struct StateData { uint64 dummy; };
  struct Read_input {};
  struct Read_output { uint64 value; };
  struct Read_locals { Counter::Get_input gi; Counter::Get_output go; };

  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);
    output.value = locals.go.value;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};
`;

test.if(hasHeaders && hasClang)(
  "clang fallback completes locals.gi. members on the cross-call repro",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qpi-fallback-e2e-"));
    try {
      const contractsDir = join(workspace, "contracts");
      mkdirSync(contractsDir, { recursive: true });
      const counterPath = join(contractsDir, "Counter.h");
      const crossCallPath = join(contractsDir, "CrossCall.h");
      writeFileSync(counterPath, COUNTER_SOURCE);
      writeFileSync(crossCallPath, CROSSCALL_SOURCE);

      const config = generateClangdConfig({
        contractPath: crossCallPath,
        corePath: BUNDLED_CORE,
        dataRoot: workspace,
        workspaceRoot: workspace,
        name: "CrossCall",
        slot: 30,
        dynCallees: { Counter: { header: counterPath, index: 29 } },
      });

      const markerLine = "    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);";
      const probeLine = "    locals.gi.";
      const buffer = CROSSCALL_SOURCE.replace(markerLine, `${markerLine}\n${probeLine}`);
      const line = buffer.split("\n").findIndex((text) => text === probeLine);

      const items = await memberFallbackCompletions({
        prefixPath: config.prefixPath,
        contractPath: config.contractFile,
        bufferText: buffer,
        line,
        character: probeLine.length,
      });

      const labels = (items ?? []).map((item) => item.name);
      expect(labels).toContain("bc");
      expect(labels).toContain("a");
      expect(existsSync(pchPathFor(config.prefixPath))).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);

// clang narrows its own answer to an exact prefix match, so the completion point sits at the member
// operator: the whole list comes back and the letters after the dot are matched by the editor.
test.if(hasHeaders && hasClang)(
  "completing at the member operator returns the whole list, and only once",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qpi-fallback-dot-"));
    try {
      const contractsDir = join(workspace, "contracts");
      mkdirSync(contractsDir, { recursive: true });
      const counterPath = join(contractsDir, "Counter.h");
      const crossCallPath = join(contractsDir, "CrossCall.h");
      writeFileSync(counterPath, COUNTER_SOURCE);
      writeFileSync(crossCallPath, CROSSCALL_SOURCE);

      const config = generateClangdConfig({
        contractPath: crossCallPath,
        corePath: BUNDLED_CORE,
        dataRoot: workspace,
        workspaceRoot: workspace,
        name: "CrossCall",
        slot: 30,
        dynCallees: { Counter: { header: counterPath, index: 29 } },
      });

      const markerLine = "    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);";
      const probeLine = "    locals.gi.a";
      const buffer = CROSSCALL_SOURCE.replace(markerLine, `${markerLine}\n${probeLine}`);
      const request = {
        prefixPath: config.prefixPath,
        contractPath: config.contractFile,
        bufferText: buffer,
        line: buffer.split("\n").findIndex((text) => text === probeLine),
        character: probeLine.lastIndexOf(".") + 1,
      };

      const runs = completionRunsForTests();
      const names = (await memberFallbackCompletions(request))?.map((item) => item.name);
      // `a` alone is what completing at the cursor would have returned.
      expect(names).toContain("a");
      expect(names).toContain("bc");
      expect(completionRunsForTests()).toBe(runs + 1);

      // The same member expression, asked again: answered from the last result, without a clang run.
      expect((await memberFallbackCompletions(request))?.map((item) => item.name)).toEqual(names!);
      expect(completionRunsForTests()).toBe(runs + 1);

      // A cancelled run comes back empty; keeping that would answer its member expression with
      // silence from then on, so the next request has to reach clang again.
      const outer = { ...request, character: probeLine.indexOf(".") + 1 };
      const aborted = {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => {} }),
      };
      expect(await memberFallbackCompletions({ ...outer, cancel: aborted })).toBeUndefined();
      expect((await memberFallbackCompletions(outer))?.map((item) => item.name)).toContain("gi");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);

// Opening a second contract regenerates its own prefix. Resolving the prefix per document is what
// keeps the caller working afterwards; a single last-wins global paired it with a foreign entry.
test.if(hasHeaders && hasClang)(
  "the caller still completes after the callee gets its own clangd config",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qpi-fallback-multi-"));
    try {
      const contractsDir = join(workspace, "contracts");
      mkdirSync(contractsDir, { recursive: true });
      const counterPath = join(contractsDir, "Counter.h");
      const crossCallPath = join(contractsDir, "CrossCall.h");
      writeFileSync(counterPath, COUNTER_SOURCE);
      writeFileSync(crossCallPath, CROSSCALL_SOURCE);

      const shared = {
        corePath: BUNDLED_CORE,
        dataRoot: workspace,
        workspaceRoot: workspace,
      };
      const callerConfig = generateClangdConfig({
        ...shared,
        contractPath: crossCallPath,
        name: "CrossCall",
        slot: 30,
        dynCallees: { Counter: { header: counterPath, index: 29 } },
      });
      const calleeConfig = generateClangdConfig({
        ...shared,
        contractPath: counterPath,
        name: "Counter",
        slot: 29,
      });
      expect(calleeConfig.prefixPath).not.toBe(callerConfig.prefixPath);

      const markerLine = "    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);";
      const probeLine = "    locals.gi.";
      const buffer = CROSSCALL_SOURCE.replace(markerLine, `${markerLine}\n${probeLine}`);
      const line = buffer.split("\n").findIndex((text) => text === probeLine);

      const items = await memberFallbackCompletions({
        prefixPath: callerConfig.prefixPath,
        contractPath: callerConfig.contractFile,
        bufferText: buffer,
        line,
        character: probeLine.length,
      });

      const labels = (items ?? []).map((item) => item.name);
      expect(labels).toContain("bc");
      expect(labels).toContain("a");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);

// The prefix includes the callee by path, so its text survives a callee edit unchanged.
test.if(hasHeaders && hasClang)(
  "editing the callee refreshes the completions",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qpi-fallback-edit-"));
    try {
      const contractsDir = join(workspace, "contracts");
      mkdirSync(contractsDir, { recursive: true });
      const counterPath = join(contractsDir, "Counter.h");
      const crossCallPath = join(contractsDir, "CrossCall.h");
      writeFileSync(counterPath, COUNTER_SOURCE);
      writeFileSync(crossCallPath, CROSSCALL_SOURCE);

      const generate = () =>
        generateClangdConfig({
          contractPath: crossCallPath,
          corePath: BUNDLED_CORE,
          dataRoot: workspace,
          workspaceRoot: workspace,
          name: "CrossCall",
          slot: 30,
          dynCallees: { Counter: { header: counterPath, index: 29 } },
        });

      const markerLine = "    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);";
      const probeLine = "    locals.gi.";
      const buffer = CROSSCALL_SOURCE.replace(markerLine, `${markerLine}\n${probeLine}`);
      const line = buffer.split("\n").findIndex((text) => text === probeLine);
      const complete = async (prefixPath: string, contractFile: string) => {
        const items = await memberFallbackCompletions({
          prefixPath,
          contractPath: contractFile,
          bufferText: buffer,
          line,
          character: probeLine.length,
        });
        return (items ?? []).map((item) => item.name);
      };

      const first = generate();
      expect(await complete(first.prefixPath, first.contractFile)).toContain("bc");

      writeFileSync(counterPath, COUNTER_SOURCE.replace("sint16 a;", "sint16 a;\n    sint16 zz;"));
      const second = generate();
      const labels = await complete(second.prefixPath, second.contractFile);
      expect(labels).toContain("zz");
      expect(labels).toContain("bc");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);

// Dependencies the key cannot see (core headers, the sysroot) still invalidate the PCH. Clang
// reports it, and the fallback rebuilds and retries rather than going silent.
test.if(hasHeaders && hasClang)(
  "a PCH clang reports as stale is rebuilt and retried",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "qpi-fallback-stale-"));
    try {
      const contractsDir = join(workspace, "contracts");
      mkdirSync(contractsDir, { recursive: true });
      const counterPath = join(contractsDir, "Counter.h");
      const crossCallPath = join(contractsDir, "CrossCall.h");
      writeFileSync(counterPath, COUNTER_SOURCE);
      writeFileSync(crossCallPath, CROSSCALL_SOURCE);

      const config = generateClangdConfig({
        contractPath: crossCallPath,
        corePath: BUNDLED_CORE,
        dataRoot: workspace,
        workspaceRoot: workspace,
        name: "CrossCall",
        slot: 30,
        dynCallees: { Counter: { header: counterPath, index: 29 } },
      });

      const markerLine = "    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);";
      const probeLine = "    locals.gi.";
      const buffer = CROSSCALL_SOURCE.replace(markerLine, `${markerLine}\n${probeLine}`);
      const line = buffer.split("\n").findIndex((text) => text === probeLine);
      const request = {
        prefixPath: config.prefixPath,
        contractPath: config.contractFile,
        bufferText: buffer,
        line,
        character: probeLine.length,
      };

      expect((await memberFallbackCompletions(request))?.map((item) => item.name)).toContain("bc");

      // Rewriting the PCH's own source with identical bytes moves its mtime, which is exactly what
      // clang refuses to load — without changing anything the cache key hashes.
      const pchSourcePath = pchSourcePathFor(config.prefixPath);
      writeFileSync(pchSourcePath, readFileSync(pchSourcePath, "utf8"));

      const labels = (await memberFallbackCompletions(request))?.map((item) => item.name);
      expect(labels).toContain("bc");
      expect(labels).toContain("a");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
  60000,
);

test.if(hasHeaders && hasClang)("the prefix PCH is rebuilt when the prefix changes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "qpi-fallback-pch-"));
  try {
    const prefixPath = join(workspace, "Probe.prefix.h");
    writeFileSync(prefixPath, "struct FromPrefix { int x; };\n");
    const clang = await findClang();
    expect(clang).toBeDefined();

    const shared = ["-std=c++20"];
    const first = await ensurePrefixPch(clang!, prefixPath, shared);
    expect(first).toBeDefined();
    const firstStat = readFileSync(`${first}.key`, "utf8");

    // Unchanged prefix: the cached PCH answers, the key file stays identical.
    const second = await ensurePrefixPch(clang!, prefixPath, shared);
    expect(second).toBe(first!);
    expect(readFileSync(`${second}.key`, "utf8")).toBe(firstStat);

    writeFileSync(prefixPath, "struct FromPrefix { int x; int y; };\n");
    const third = await ensurePrefixPch(clang!, prefixPath, shared);
    expect(third).toBe(first!);
    expect(readFileSync(`${third}.key`, "utf8")).not.toBe(firstStat);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 60000);
