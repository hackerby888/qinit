// Pure formatting helpers behind the explorer's stat tiles. fmtCompact is the interesting one: it has to
// stay correct past 2^53, where Number-based scaling silently drifts.
import { test, expect } from "bun:test";
import { fmtCompact, truncMid, truncEnd } from "../../src/ui";
import { hintLines, parseFindQuery } from "../../src/commands/explorer";

const SEPARATOR = 5; // "  ·  " between hints on a line
const lineWidth = (line: [string, string][]) =>
  line.reduce((total, [key, label]) => total + key.length + 1 + label.length, 0) +
  SEPARATOR * (line.length - 1);

test("fmtCompact scales by magnitude and keeps one decimal", () => {
  expect(fmtCompact("0")).toBe("0");
  expect(fmtCompact("999")).toBe("999");
  expect(fmtCompact("1000")).toBe("1.0 K");
  expect(fmtCompact("15400")).toBe("15.4 K");
  expect(fmtCompact("1000000")).toBe("1.0 M");
  expect(fmtCompact("32000000000000")).toBe("32.0 T");
});

test("fmtCompact stays exact past 2^53 and handles signs", () => {
  // 2^53 is 9007199254740992 — a Number-based implementation starts rounding right about here.
  expect(fmtCompact("9007199254740993")).toBe("9.0 P");
  expect(fmtCompact("123456789012345678901")).toBe("123.4 E");
  expect(fmtCompact("-2500")).toBe("-2.5 K");
});

test("fmtCompact passes through anything that is not a plain integer", () => {
  expect(fmtCompact("")).toBe("");
  expect(fmtCompact("n/a")).toBe("n/a");
  expect(fmtCompact("12.5")).toBe("12.5");
});

// The explorer's shell budgets terminal rows from this line count, so a wrap it did not predict pushes
// the control bar off-screen.
test("hintLines wraps to fit the terminal and never drops a hint", () => {
  const keys: [string, string][] = [
    ["1", "overview"],
    ["2", "contracts"],
    ["3", "identity"],
    ["↑↓", "select"],
    ["↵", "open"],
    ["r", "refresh"],
    ["t", "theme"],
    ["q", "quit"],
  ];

  for (const columns of [40, 80, 120, 200]) {
    const lines = hintLines(keys, columns);
    expect(lines.flat()).toEqual(keys); // every hint survives, in order
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0); // no empty line inflating the row count
      if (line.length > 1) {
        expect(lineWidth(line)).toBeLessThanOrEqual(columns - 1);
      }
    }
  }

  expect(hintLines(keys, 200).length).toBe(1);
  expect(hintLines(keys, 80).length).toBe(2);
});

// The explorer's one search field routes by the shape of what was typed, so this is the whole dispatch.
test("find query routes by shape", () => {
  const identity = "A".repeat(60);

  expect(parseFindQuery(" 12480 ")).toEqual({ kind: "tick", tick: 12480 });
  expect(parseFindQuery("0")).toEqual({ kind: "tick", tick: 0 });
  expect(parseFindQuery(identity)).toEqual({ kind: "identity", id: identity });
  // A tx id is the identity alphabet lowercased, so case is the only thing separating the two.
  expect(parseFindQuery("a".repeat(60))).toEqual({ kind: "tx", hash: "a".repeat(60) });
  expect(parseFindQuery(identity.toLowerCase().slice(0, 59) + "A")).toEqual({
    kind: "identity",
    id: identity,
  });

  for (const bad of ["", "  ", "-5", "12.5", "12a", "abc", "A".repeat(59), "A".repeat(61)]) {
    expect(parseFindQuery(bad)).toBeNull();
  }
});

test("truncation helpers keep values inside a fixed cell width", () => {
  expect(truncEnd("abcdef", 10)).toBe("abcdef");
  expect(truncEnd("abcdef", 4).length).toBe(4);
  expect(truncMid("abcdefghij", 10)).toBe("abcdefghij");
  expect(truncMid("abcdefghij", 7).length).toBe(7);
  expect(truncMid("abcdefghij", 7)).toContain("…");
});
