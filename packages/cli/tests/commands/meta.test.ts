import { test, expect } from "bun:test";
import { META, COMMANDS, GROUP_ORDER, commandOptions, optionSyntax } from "../../src/meta";

test("META: every command has a non-empty summary in a known group", () => {
  for (const m of Object.values(META)) {
    expect(typeof m.summary).toBe("string");
    expect(m.summary.length).toBeGreaterThan(0);
    expect(GROUP_ORDER).toContain(m.group);
  }
});

test("COMMANDS mirrors the META keys — unique and non-empty", () => {
  expect(COMMANDS.length).toBeGreaterThan(0);
  expect(COMMANDS).toEqual(Object.keys(META));
  expect(new Set(COMMANDS).size).toBe(COMMANDS.length);
});

test("META: options are complete structured parser definitions", () => {
  for (const [command, meta] of Object.entries(META)) {
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
  expect(commandOptions("node", "run").map(optionSyntax)).toContain("--core <path>");
  expect(commandOptions("state").map(optionSyntax)).toContain("--digest");
  expect(META.build.json).toBe(true);
});

test("accepted build, dev, gen, and call options are documented", () => {
  expect(commandOptions("build").map((option) => option.name)).toEqual(
    expect.arrayContaining(["contract", "rpc", "callee"]),
  );
  expect(commandOptions("dev").map((option) => option.name)).toEqual(
    expect.arrayContaining(["contract", "name", "core", "callee"]),
  );
  expect(commandOptions("gen").map((option) => option.name)).toEqual(
    expect.arrayContaining(["contract", "core"]),
  );
  expect(commandOptions("call").map((option) => option.name)).toEqual(
    expect.arrayContaining(["args", "amount", "all", "no-settle"]),
  );
});
