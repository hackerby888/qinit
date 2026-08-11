import { test, expect } from "bun:test";
import {
  META,
  COMMANDS,
  GROUP_ORDER,
  commandOptions,
  optionSyntax,
  type CommandName,
} from "../../src/meta";

test("META: every command has a non-empty summary in a known group", () => {
  for (const m of Object.values(META)) {
    expect(typeof m.summary).toBe("string");
    expect(m.summary.length).toBeGreaterThan(0);
    expect(GROUP_ORDER).toContain(m.group);
  }
});

test("COMMANDS mirrors the META keys — unique and non-empty", () => {
  expect(COMMANDS.length).toBeGreaterThan(0);
  expect(COMMANDS).toEqual(Object.keys(META) as CommandName[]);
  expect(new Set(COMMANDS).size).toBe(COMMANDS.length);
});

test("META: options are complete structured parser definitions", () => {
  for (const command of COMMANDS) {
    const meta = META[command];
    const groups = [meta.options ?? [], ...Object.values(meta.subcommands ?? {}).map((s) => s.options)];
    for (const options of groups) {
      expect(new Set(options.map((option) => option.name)).size).toBe(options.length);
      for (const option of options) {
        expect(option.name).toMatch(/^[a-z][a-z-]*$/);
        expect(["string", "boolean"]).toContain(option.type);
        expect(option.description.length).toBeGreaterThan(0);
        expect(optionSyntax(option)).toStartWith(`--${option.name}`);
        if (option.type === "boolean") {
          expect(option.valueLabel).toBeUndefined();
          expect(option.multiple).not.toBe(true);
        } else {
          expect(option.valueLabel?.length).toBeGreaterThan(0);
        }
      }
    }
    expect(commandOptions(command)).toEqual(meta.options ?? []);
  }
});

test("META: optional fields are well-typed when present", () => {
  for (const m of Object.values(META)) {
    if ("json" in m) {
      expect(typeof m.json).toBe("boolean");
    }
    if (m.usage !== undefined) {
      expect(typeof m.usage).toBe("string");
    }
    if (m.examples) {
      expect(Array.isArray(m.examples)).toBe(true);
      expect(m.examples.every((e) => typeof e === "string")).toBe(true);
    }
  }
});

test("GROUP_ORDER: every declared group is used by at least one command", () => {
  const used = new Set(Object.values(META).map((m) => m.group));

  for (const g of GROUP_ORDER) {
    expect(used.has(g)).toBe(true);
  }
});

test("release-smoke flags are exposed in command metadata", () => {
  expect(commandOptions("node", "run").map(optionSyntax)).toContain("--core-dir <path>");
  expect(commandOptions("node", "run").map(optionSyntax)).toContain(
    "--runtime <core|simulator>",
  );
  expect(commandOptions("test").map(optionSyntax)).toContain(
    "--runtime <core|simulator>",
  );
  expect(commandOptions("state").map(optionSyntax)).toContain("--digest");
  expect(commandOptions("state").map(optionSyntax)).toContain("--container <index>");
  expect(commandOptions("state").map(optionSyntax)).toContain("--all");
  expect(META.build.json).toBe(true);
});

test("node subcommands are declared for routing and option scoping", () => {
  expect(Object.keys(META.node.subcommands ?? {})).toEqual([
    "run",
    "status",
    "stop",
    "get",
  ]);
});

test("accepted build, dev, gen, and call options are documented", () => {
  expect(commandOptions("build").map((option) => option.name)).toEqual(
    expect.arrayContaining(["contract", "rpc", "callee"]),
  );
  expect(commandOptions("dev").map((option) => option.name)).toEqual(
    expect.arrayContaining(["contract", "contract-name", "core-dir", "callee", "compiler"]),
  );
  expect(commandOptions("gen").map((option) => option.name)).toEqual(
    expect.arrayContaining(["contract", "contract-name", "core-dir"]),
  );
  expect(commandOptions("call").map((option) => option.name)).toEqual(
    expect.arrayContaining(["args", "amount", "all", "no-settle"]),
  );
});

test("legacy backend and path flags are not accepted", () => {
  const optionNames = Object.entries(META).flatMap(([command, meta]) => [
    ...(meta.options ?? []).map((option) => `${command}:${option.name}`),
    ...Object.entries(meta.subcommands ?? {}).flatMap(([subcommand, sub]) =>
      sub.options.map((option) => `${command} ${subcommand}:${option.name}`),
    ),
  ]);

  for (const legacy of ["native", "local", "core", "bin", "dir", "mode"]) {
    expect(optionNames.some((entry) => entry.endsWith(`:${legacy}`))).toBe(false);
  }
  expect(COMMANDS).toContain("runtime");
  expect(COMMANDS).not.toContain("node-backend");
  expect(optionNames.some((entry) => entry.endsWith(":node-backend"))).toBe(false);
  expect(COMMANDS).not.toContain("mode");
});
