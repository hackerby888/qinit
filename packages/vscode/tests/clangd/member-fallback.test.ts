import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateClangdConfig } from "../../src/clangd-config";
import {
  compileEntryFor,
  ensurePrefixPch,
  findClang,
  memberFallbackCompletions,
  parseCompletions,
  pchPathFor,
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

// Captured from `clang++ -Xclang -code-completion-at` on the CrossCall repro.
const CLANG_OUTPUT = `COMPLETION: a : [#sint16#]a
COMPLETION: bc : [#Array<uint64, 8>#]bc
COMPLETION: Get_input : Get_input::
COMPLETION: operator= : [#Get_input &#]operator=(<#const Get_input &#>)
COMPLETION: ~Get_input : [#void#]~Get_input()
COMPLETION: Pattern : static_cast<<#type#>>(<#expression#>)
COMPLETION: _Nonnull
`;

test("parseCompletions keeps members, drops Pattern rows and reserved names", () => {
  const items = parseCompletions(CLANG_OUTPUT);
  const labels = items.map((item) => item.label);

  expect(labels).toContain("a");
  expect(labels).toContain("bc");
  expect(labels).toContain("operator=");
  expect(labels).not.toContain("Pattern");
  expect(labels).not.toContain("_Nonnull");
});

test("parseCompletions reads types and tells fields from methods", () => {
  const items = parseCompletions(CLANG_OUTPUT);
  const byLabel = new Map(items.map((item) => [item.label, item]));

  expect(byLabel.get("bc")?.kind).toBe("field");
  expect(byLabel.get("bc")?.detail).toBe("Array<uint64, 8> bc");
  expect(byLabel.get("a")?.detail).toBe("sint16 a");
  expect(byLabel.get("operator=")?.kind).toBe("method");
  expect(byLabel.get("operator=")?.detail).toBe("Get_input & operator=(const Get_input &)");
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

      const labels = (items ?? []).map((item) => item.label);
      expect(labels).toContain("bc");
      expect(labels).toContain("a");
      expect(existsSync(pchPathFor(config.prefixPath))).toBe(true);
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
