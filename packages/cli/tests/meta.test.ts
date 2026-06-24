// META is the single source for the help screen, per-command help, completion, and did-you-mean. A malformed
// entry (missing summary, a group typo, a bad flag tuple) silently breaks those surfaces, so pin the shape.
import { test, expect } from "bun:test";
import { META, COMMANDS, GROUP_ORDER } from "../src/meta";

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

test("META: flags are [flag, desc] pairs of non-empty strings", () => {
  for (const m of Object.values(META)) {
    if (!m.flags) {
      continue;
    }
    for (const f of m.flags) {
      expect(Array.isArray(f)).toBe(true);
      expect(f.length).toBe(2);
      expect(f[0].length).toBeGreaterThan(0);
      expect(f[1].length).toBeGreaterThan(0);
    }
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
