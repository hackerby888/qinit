import { expect, test } from "bun:test";
import type { DebugEntry } from "@qinit/core";
import { formatTraceAge, idlCacheKey, mergeTraceEntries, traceSelectionIndex, visibleForTarget } from "../../src/commands/deploy-interact/debug";

const frame = (fields: Partial<DebugEntry>): DebugEntry =>
    ({ seq: 0, tick: 1, index: 29, entry: 1, kind: 1, ok: true, hostCalls: [], logs: [], cheats: [], ...fields }) as DebugEntry;

// a callee shows under the contract that called it; another contract's BEGIN_TICK in the same tick does not.
test("debug keeps the target's frames and the frames they called", () => {
    const withChildren = [
        frame({ seq: 1, index: 28, kind: 1 }),
        frame({ seq: 2, index: 29, kind: 1, children: [1] }),
        frame({ seq: 3, index: 5, kind: 2, children: [] }),
        frame({ seq: 4, index: 28, kind: 0, children: [] }),
    ];
    expect(visibleForTarget(withChildren, (entry) => entry.index === 29).map((entry) => entry.seq)).toEqual([1, 2]);

    // a node too old to record children: the completion window, minus the sysprocs a user call never makes.
    const window = [
        frame({ seq: 1, index: 5, kind: 2 }),
        frame({ seq: 2, index: 28, kind: 1 }),
        frame({ seq: 3, index: 29, kind: 1 }),
        frame({ seq: 4, index: 28, kind: 1 }),
    ];
    expect(visibleForTarget(window, (entry) => entry.index === 29).map((entry) => entry.seq)).toEqual([2, 3]);
});

test("debug traces merge once in newest-first order and stay hidden", () => {
    const previous = [
        { seq: 1, value: "one" },
        { seq: 2, value: "old two" },
        { seq: 3, value: "old three" },
    ];
    const incoming = [
        { seq: 2, value: "two" },
        { seq: 5, value: "five" },
        { seq: 3, value: "new three" },
    ];

    const merged = mergeTraceEntries(previous, incoming, new Set([2]));

    expect(merged.map((entry) => entry.seq)).toEqual([5, 3, 1]);
    expect(merged[1].value).toBe("new three");
    expect(previous.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(incoming.map((entry) => entry.seq)).toEqual([2, 5, 3]);

    expect(mergeTraceEntries(merged, [{ seq: 2, value: "late two" }], new Set([2])).map((entry) => entry.seq)).toEqual([5, 3, 1]);
});

test("debug trace retention keeps the newest 500 entries", () => {
    const entries = Array.from({ length: 502 }, (_, seq) => ({ seq }));
    const merged = mergeTraceEntries([], entries, new Set());

    expect(merged).toHaveLength(500);
    expect(merged[0].seq).toBe(501);
    expect(merged[499].seq).toBe(2);
});

test("debug selection follows newest or resolves a selected sequence", () => {
    const entries = [{ seq: 9 }, { seq: 7 }, { seq: 3 }];

    expect(traceSelectionIndex(entries, null)).toBe(0);
    expect(traceSelectionIndex(entries, 7)).toBe(1);
    expect(traceSelectionIndex(entries, 100)).toBe(2);
});

test("debug trace age uses the supplied chain clock", () => {
    const tickMs = 1_000_000;

    expect(formatTraceAge()).toBe("—");
    expect(formatTraceAge(tickMs, tickMs)).toBe("now");
    expect(formatTraceAge(tickMs + 1_000, tickMs)).toBe("now");
    expect(formatTraceAge(tickMs, tickMs + 30_000)).toBe("30 sec ago");
    expect(formatTraceAge(tickMs, tickMs + 60_000)).toBe("1 min ago");
    expect(formatTraceAge(tickMs, tickMs + 2 * 60 * 60_000)).toBe("2 hr ago");
    expect(formatTraceAge(tickMs, tickMs + 24 * 60 * 60_000)).toBe("1 day ago");
});

test("debug idl cache key follows a redeploy into the same slot", () => {
    const before = [
        { index: 29, codeHash: "aa" },
        { index: 30, codeHash: "bb" },
    ] as any;
    const reordered = [
        { index: 30, codeHash: "bb" },
        { index: 29, codeHash: "aa" },
    ] as any;
    const redeployed = [
        { index: 29, codeHash: "cc" },
        { index: 30, codeHash: "bb" },
    ] as any;

    expect(idlCacheKey(reordered)).toBe(idlCacheKey(before));
    expect(idlCacheKey(redeployed)).not.toBe(idlCacheKey(before));
    expect(idlCacheKey([{ index: 29 }] as any)).toBe("29:");
});
