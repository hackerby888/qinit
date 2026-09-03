import { expect, test } from "bun:test";
import { stateJsonResult } from "../../src/commands/deploy-interact/state";
import type { DecodedState } from "../../src/trace/state-read";

const DECODED = {
    complete: true,
    fields: [{ name: "counter", value: "16" }],
    containers: [
        {
            index: 1,
            name: "abc_map",
            kind: "hashmap",
            size: 262144,
            status: "loaded",
            capacity: 1024,
            occupiedSlots: 3,
            totalEntries: 3,
            lines: [{ label: "[167]", text: "16", filled: true }],
            sourceField: { name: "abc_map", abi: { kind: "struct", fields: [] } },
        },
    ],
} as unknown as DecodedState;

test("state JSON reports the decoded fields and container summary", () => {
    const result = stateJsonResult("Counter", 29, DECODED, "");

    expect(result).toEqual({
        ok: true,
        contract: "Counter",
        slot: 29,
        complete: true,
        fields: [{ name: "counter", value: "16" }],
        containers: [
            {
                index: 1,
                name: "abc_map",
                kind: "hashmap",
                size: 262144,
                status: "loaded",
                capacity: 1024,
                occupiedSlots: 3,
                totalEntries: 3,
                lines: [{ label: "[167]", text: "16", filled: true }],
                error: null,
            },
        ],
        error: null,
    });
});

test("state JSON drops the container's ABI layout", () => {
    const result = stateJsonResult("Counter", 29, DECODED, "");

    for (const container of result.containers) {
        expect(container).not.toHaveProperty("sourceField");
    }
});

test("state JSON reports a partial read as not ok", () => {
    const partial = { ...DECODED, complete: false } as DecodedState;

    expect(stateJsonResult("Counter", 29, partial, "").ok).toBe(false);
});

test("state JSON carries the message when the read never produced a state", () => {
    const result = stateJsonResult("", null, null, "no contract 'Nope'");

    expect(result).toEqual({
        ok: false,
        contract: null,
        slot: null,
        complete: null,
        fields: [],
        containers: [],
        error: "no contract 'Nope'",
    });
});

// A container reached through a struct field carries no index: `--container` cannot address it, and a
// consumer reading the JSON has to see it all the same.
test("state JSON carries a nested container block with no index", () => {
    const nested = {
        ...DECODED,
        containers: [
            ...DECODED.containers,
            {
                index: 0,
                name: "inner.map",
                kind: "hashmap",
                size: 88,
                status: "loaded",
                capacity: 4,
                occupiedSlots: 1,
                totalEntries: 1,
                lines: [{ label: "slot[1]", text: "5 = 7", filled: true }],
                sourceField: { name: "map", abi: { kind: "struct", fields: [] } },
            },
        ],
    } as unknown as DecodedState;

    const result = stateJsonResult("Counter", 29, nested, "");

    expect(result.containers.map((container) => [container.name, container.index])).toEqual([
        ["abc_map", 1],
        ["inner.map", 0],
    ]);
    expect(result.containers[1]).not.toHaveProperty("sourceField");
});
