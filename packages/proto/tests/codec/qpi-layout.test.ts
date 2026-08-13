import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
    arrayGeometry,
    bitArrayGeometry,
    bitWordCount,
    hashMapFmt,
    hashSetFmt,
    collectionFmt,
    linkedListFmt,
    hashMapElemFmt,
    collectionElemFmt,
    collectionGeometry,
    collectionMembers,
    hashMapGeometry,
    hashMapMembers,
    hashSetGeometry,
    hashSetMembers,
    linkedListGeometry,
    linkedListMembers,
    COLLECTION_POV_FMT,
    type ContainerRegion,
} from "../../src/qpi-layout";
import { layoutOf } from "../../src/abi-fmt";

test("BitArray word count covers every logical bit", () => {
    expect([1, 64, 65, 4096].map(bitWordCount)).toEqual([1, 1, 2, 64]);
});

test("array and BitArray geometry includes physical size and alignment", () => {
    expect(arrayGeometry({ size: 3, align: 2 }, 4)).toEqual({
        stride: 4,
        size: 16,
        align: 2,
    });
    expect(bitArrayGeometry(65)).toEqual({ size: 16, align: 8 });
});

test("container geometry aligns flags and Collection elements", () => {
    expect(hashMapGeometry({ size: 1, align: 1 }, { size: 1, align: 1 }, 1)).toEqual({
        recordStride: 2,
        valueOffset: 1,
        flagsOffset: 8,
        flagsBytes: 8,
        populationOffset: 16,
        size: 32,
        align: 8,
    });
    expect(hashSetGeometry({ size: 1, align: 1 }, 4)).toEqual({
        recordStride: 1,
        flagsOffset: 8,
        flagsBytes: 8,
        populationOffset: 16,
        size: 32,
        align: 8,
    });
    expect(collectionGeometry({ size: 16, align: 16 }, 1)).toEqual({
        povsOffset: 0,
        povStride: 64,
        povValueOffset: 0,
        povPopulationOffset: 32,
        povHeadOffset: 40,
        povTailOffset: 48,
        povBstRootOffset: 56,
        flagsOffset: 64,
        flagsBytes: 8,
        elementsOffset: 80,
        elementStride: 64,
        elementValueOffset: 0,
        elementPriorityOffset: 16,
        elementPovIndexOffset: 24,
        elementBstParentOffset: 32,
        elementBstLeftOffset: 40,
        elementBstRightOffset: 48,
        populationOffset: 144,
        size: 160,
        align: 16,
    });
});

test("LinkedList geometry matches QPI node and header layout", () => {
    expect(linkedListGeometry({ size: 8, align: 8 }, 8)).toEqual({
        nextOffset: 8,
        prevOffset: 16,
        nodeStride: 24,
        flagsOffset: 192,
        flagsBytes: 8,
        headOffset: 200,
        tailOffset: 208,
        freeHeadOffset: 216,
        nextUnusedOffset: 224,
        populationOffset: 232,
        size: 240,
        align: 8,
    });
    expect(linkedListGeometry({ size: 24, align: 16 }, 2)).toEqual({
        nextOffset: 24,
        prevOffset: 32,
        nodeStride: 48,
        flagsOffset: 96,
        flagsBytes: 8,
        headOffset: 104,
        tailOffset: 112,
        freeHeadOffset: 120,
        nextUnusedOffset: 128,
        populationOffset: 136,
        size: 144,
        align: 16,
    });
});

test("hashMapFmt: matches the C++ StateData layout + sizeof pin (41232)", () => {
    expect(hashMapFmt("id", "uint64", 1024)).toBe(
        "{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }",
    );
    expect(layoutOf(hashMapFmt("id", "uint64", 1024)).size).toBe(41232); // DbgMap marker offset
});

test("hashSetFmt / collectionFmt shapes", () => {
    expect(hashSetFmt("id", 64)).toBe("{ [64;id], [2;uint64], uint64, uint64 }");
    expect(collectionFmt("uint64", 4)).toBe(
        "{ [4;{ id, uint64, sint64, sint64, sint64 }], [1;uint64], [4;{ uint64, sint64, sint64, sint64, sint64, sint64 }], uint64, uint64 }",
    );
    expect(linkedListFmt("uint64", 8)).toBe(
        "{ [8;{ uint64, sint64, sint64 }], [1;uint64], sint64, sint64, sint64, uint64, uint64 }",
    );
    expect(layoutOf(linkedListFmt("uint64", 8))).toEqual({
        size: 240,
        align: 8,
    });
});

test("element fmts (consumed by the decoders) are the single source", () => {
    expect(hashMapElemFmt("id", "uint64")).toBe("id, uint64");
    expect(COLLECTION_POV_FMT).toBe("id, uint64, sint64, sint64, sint64");
    expect(collectionElemFmt("uint64")).toBe("uint64, sint64, sint64, sint64, sint64, sint64");
});

// Nothing in the ABI carries the names of a container's internals, so the member tables spell them out.
// The qpi.h snapshot embeds the header verbatim and is regenerated whenever the core-lite pin moves, which
// makes it the one place a rename upstream can be caught.
const SNAPSHOT = readFileSync(
    new URL("../../../compiler/src/generated/qpi-snapshot.ts", import.meta.url),
    "utf8",
);

// Only the private block declares members; the public methods below it repeat the same words.
function privateBlock(declaration: string): string {
    const start = SNAPSHOT.indexOf(declaration);
    if (start < 0) {
        throw new Error(`${declaration} is missing from the qpi.h snapshot`);
    }
    return SNAPSHOT.slice(start, SNAPSHOT.indexOf("public:", start));
}

// A HashSet slot is the key itself, so it has no member name of its own to pin.
const sourcesOf = (regions: ContainerRegion[]) =>
    [
        ...new Set(
            regions.flatMap((region) =>
                region.kind === "records"
                    ? [region.source, ...region.members.map((member) => member.source)]
                    : [region.source],
            ),
        ),
    ].filter((source) => source.length > 0);

test("container member names still match the ones core declares", () => {
    const word = { size: 8, align: 8 };
    const containers: [string, string[]][] = [
        ["class HashMap", sourcesOf(hashMapMembers(word, word, 4))],
        ["class HashSet", sourcesOf(hashSetMembers(word, 4))],
        ["struct Collection", sourcesOf(collectionMembers(word, 4))],
        ["class LinkedList", sourcesOf(linkedListMembers(word, 4))],
    ];
    const drifted: Record<string, string[]> = {};

    for (const [declaration, names] of containers) {
        const block = privateBlock(declaration);
        // The leading boundary rejects a longer name that merely ends with this one — `headIndex` must not
        // be satisfied by Collection's own `_headIndex()`.
        const missing = names.filter((name) => !new RegExp(`(?<!\\w)${name}\\b`).test(block));
        if (missing.length) {
            drifted[declaration] = missing;
        }
    }

    expect(drifted).toEqual({});
});
