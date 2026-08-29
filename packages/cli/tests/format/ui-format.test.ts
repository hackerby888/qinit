// Pure formatting helpers behind the explorer's stat tiles. fmtCompact is the interesting one: it has to
// stay correct past 2^53, where Number-based scaling silently drifts.
import { test, expect } from "bun:test";
import { fmtCompact, fmtMs, truncMid, truncEnd } from "../../src/ui";
import { initialView, parseFindQuery } from "../../src/commands/deploy-interact/explorer";
import { parseCommandInvocation } from "../../src/args";
import { hintLines } from "../../src/commands/deploy-interact/explorer/chrome";
import { classifyWalletInput, poolSeedForIdentity } from "../../src/commands/deploy-interact/explorer/wallet";

const SEPARATOR = 5; // "  ·  " between hints on a line
const lineWidth = (line: [string, string][]) => line.reduce((total, [key, label]) => total + key.length + 1 + label.length, 0) + SEPARATOR * (line.length - 1);

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
        expect(lines.flat()).toEqual(keys);
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

// The command line runs through the same shape rule the search prompt uses.
test("the explorer's opening view is resolved from its one argument", () => {
    const identity = "A".repeat(60);
    const opening = (args: string[]) => initialView(parseCommandInvocation("explorer", args).commandArgs);

    expect(opening([])).toEqual({ kind: "overview" });
    expect(opening(["7474"])).toEqual({ kind: "tick", tick: 7474 });
    expect(opening(["a".repeat(60)])).toEqual({ kind: "tx", hash: "a".repeat(60) });
    expect(opening([identity.toLowerCase().slice(0, 59) + "A"])).toEqual({
        kind: "identity",
        id: identity,
    });

    expect(() => opening(["zzz"])).toThrow("not a tick number, identity, or transaction hash: zzz");
    try {
        opening(["zzz"]);
    } catch (error) {
        expect((error as Error & { code?: string }).code).toBe("ERR_PARSE_ARGS_INVALID_POSITIONAL");
    }

    // The shape flags this replaced are gone; strict parsing keeps them from creeping back.
    expect(() => parseCommandInvocation("explorer", ["--tick", "5"])).toThrow();
    expect(() => parseCommandInvocation("explorer", ["--id", identity])).toThrow();
});

// The wallet's one-field-takes-either trick rests entirely on the shapes not overlapping.
test("wallet input is classified by shape", () => {
    expect(classifyWalletInput("a".repeat(55))).toBe("seed");
    expect(classifyWalletInput("  " + "z".repeat(55) + "  ")).toBe("seed");
    expect(classifyWalletInput("A".repeat(60))).toBe("identity");

    expect(classifyWalletInput("")).toBe("empty");
    expect(classifyWalletInput("   ")).toBe("empty");

    // Half-typed is not wrong yet — it must not show as an error while the user is still going.
    // 55 uppercase is a partly typed identity, not a seed: case decides which target it is measured against.
    expect(classifyWalletInput("a".repeat(54))).toBe("partial");
    expect(classifyWalletInput("A".repeat(59))).toBe("partial");
    expect(classifyWalletInput("A".repeat(55))).toBe("partial");

    // Past either target length there is nothing left to become.
    expect(classifyWalletInput("a".repeat(60))).toBe("invalid");
    expect(classifyWalletInput("A".repeat(61))).toBe("invalid");
    expect(classifyWalletInput("a".repeat(30) + "A".repeat(25))).toBe("invalid");
    expect(classifyWalletInput("a".repeat(54) + "1")).toBe("invalid");
});

// No live backend reaches these branches: the simulator's pool is small and always present, so a
// truncated reply and a missing route only ever appear against a real core node.
test("funded-pool lookup separates a miss from an unreachable route", () => {
    const identity = "A".repeat(60);
    const pool = {
        seedByIdentity: new Map([[identity, "a".repeat(55)]]),
        received: 1,
        total: 1,
    };

    expect(poolSeedForIdentity(identity, pool, "")).toBe("a".repeat(55));

    // A node built without TESTNET 404s the route; saying "not prefunded" there would be a lie.
    expect(() => poolSeedForIdentity(identity, null, "404 Not Found")).toThrow(/route unavailable/);

    expect(() => poolSeedForIdentity("B".repeat(60), pool, "")).toThrow(/not in the node's funded-seed pool — the pool holds 1 seed/);

    // A short reply must report how short it was, so a miss is not mistaken for proof of absence.
    const truncated = { ...pool, received: 32, total: 676 };
    expect(() => poolSeedForIdentity("B".repeat(60), truncated, "")).toThrow(/only 32 of 676 pool seeds/);
});

test("truncation helpers keep values inside a fixed cell width", () => {
    expect(truncEnd("abcdef", 10)).toBe("abcdef");
    expect(truncEnd("abcdef", 4).length).toBe(4);
    expect(truncMid("abcdefghij", 10)).toBe("abcdefghij");
    expect(truncMid("abcdefghij", 7).length).toBe(7);
    expect(truncMid("abcdefghij", 7)).toContain("…");
});

test("fmtCompact holds its unit at the widest one it has and normalises padded digits", () => {
    // 22 digits is past the last unit's range, so the scale clamps rather than running off the table.
    expect(fmtCompact("1" + "0".repeat(21))).toBe("1000.0 E");
    expect(fmtCompact("9".repeat(24))).toBe("999999.9 E");

    // A zero-padded amount reads as its value, and an all-zero one still reads as "0".
    expect(fmtCompact("000")).toBe("0");
    expect(fmtCompact("0000000000001000")).toBe("1.0 K");
    expect(fmtCompact("-000")).toBe("-0");
});

test("truncation helpers put the ellipsis where the wider half of the value survives", () => {
    // An odd budget leaves the head one character longer than the tail.
    expect(truncMid("abcdef", 4)).toBe("ab…f");
    expect(truncMid("abcdefghij", 7)).toBe("abc…hij");
    expect(truncMid("abcdefghij", 5)).toBe("ab…ij");
    expect(truncEnd("abcdef", 4)).toBe("abc…");
    expect(truncEnd("abcdef", 1)).toBe("a…");
});

test("truncation counts UTF-16 units, so an astral character can be cut in half", () => {
    // Pinned, not endorsed: the cells budget in code units, and a pair that straddles the cut splits.
    expect(truncEnd("😀😀😀", 4)).toBe("😀\ud83d…");
    expect(truncMid("😀😀😀", 4)).toBe("😀…\ude00");
    expect(truncEnd("plain😀", 6)).toBe("plain…");
});

test("fmtMs switches to seconds at exactly one second", () => {
    expect(fmtMs(undefined)).toBe("");
    expect(fmtMs(0)).toBe("0ms");
    expect(fmtMs(999)).toBe("999ms");
    expect(fmtMs(1000)).toBe("1.0s");
    expect(fmtMs(1949)).toBe("1.9s");
});
