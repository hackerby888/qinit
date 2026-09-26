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
    collectionRegions,
    hashMapGeometry,
    hashMapRegions,
    hashSetGeometry,
    hashSetRegions,
    linkedListGeometry,
    linkedListRegions,
    COLLECTION_POV_FMT,
    type ContainerRegion,
} from "../../src/qpi-layout";
import { layoutOf } from "../../src/abi";

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
        elementStride: 2,
        elementValueOffset: 1,
        flagsOffset: 8,
        flagsBytes: 8,
        populationOffset: 16,
        markRemovalCounterOffset: 24,
        size: 32,
        align: 8,
    });
    expect(hashSetGeometry({ size: 1, align: 1 }, 4)).toEqual({
        keyStride: 1,
        flagsOffset: 8,
        flagsBytes: 8,
        populationOffset: 16,
        markRemovalCounterOffset: 24,
        size: 32,
        align: 8,
    });
    expect(collectionGeometry({ size: 16, align: 16 }, 1)).toEqual({
        povsOffset: 0,
        povStride: 64,
        povValueOffset: 0,
        povPopulationOffset: 32,
        povHeadIndexOffset: 40,
        povTailIndexOffset: 48,
        povBstRootIndexOffset: 56,
        flagsOffset: 64,
        flagsBytes: 8,
        elementsOffset: 80,
        elementStride: 64,
        elementValueOffset: 0,
        elementPriorityOffset: 16,
        elementPovIndexOffset: 24,
        elementBstParentIndexOffset: 32,
        elementBstLeftIndexOffset: 40,
        elementBstRightIndexOffset: 48,
        populationOffset: 144,
        markRemovalCounterOffset: 152,
        size: 160,
        align: 16,
    });
});

test("LinkedList geometry matches QPI node and header layout", () => {
    expect(linkedListGeometry({ size: 8, align: 8 }, 8)).toEqual({
        nextIndexOffset: 8,
        prevIndexOffset: 16,
        nodeStride: 24,
        flagsOffset: 192,
        flagsBytes: 8,
        headIndexOffset: 200,
        tailIndexOffset: 208,
        freeHeadIndexOffset: 216,
        nextUnusedIndexOffset: 224,
        populationOffset: 232,
        size: 240,
        align: 8,
    });
    expect(linkedListGeometry({ size: 24, align: 16 }, 2)).toEqual({
        nextIndexOffset: 24,
        prevIndexOffset: 32,
        nodeStride: 48,
        flagsOffset: 96,
        flagsBytes: 8,
        headIndexOffset: 104,
        tailIndexOffset: 112,
        freeHeadIndexOffset: 120,
        nextUnusedIndexOffset: 128,
        populationOffset: 136,
        size: 144,
        align: 16,
    });
});

test("hashMapFmt: matches the C++ StateData layout + sizeof pin (41232)", () => {
    expect(hashMapFmt("id", "uint64", 1024)).toBe("{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }");
    expect(layoutOf(hashMapFmt("id", "uint64", 1024)).size).toBe(41232); // DbgMap marker offset
});

test("hashSetFmt / collectionFmt shapes", () => {
    expect(hashSetFmt("id", 64)).toBe("{ [64;id], [2;uint64], uint64, uint64 }");
    expect(collectionFmt("uint64", 4)).toBe(
        "{ [4;{ id, uint64, sint64, sint64, sint64 }], [1;uint64], [4;{ uint64, sint64, sint64, sint64, sint64, sint64 }], uint64, uint64 }",
    );
    expect(linkedListFmt("uint64", 8)).toBe("{ [8;{ uint64, sint64, sint64 }], [1;uint64], sint64, sint64, sint64, uint64, uint64 }");
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

// Nothing in the ABI carries a container's internal names, so the member tables spell them out; the qpi.h snapshot moves with the core pin and catches renames.
const SNAPSHOT = readFileSync(new URL("../../../compiler/src/generated/qpi-snapshot.ts", import.meta.url), "utf8");

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
            regions.flatMap((region) => (region.kind === "slots" ? [region.source, ...region.members.map((member) => member.source)] : [region.source])),
        ),
    ].filter((source) => source.length > 0);

test("container member names still match the ones core declares", () => {
    const word = { size: 8, align: 8 };
    const containers: [string, string[]][] = [
        ["class HashMap", sourcesOf(Object.values(hashMapRegions(word, word, 4)))],
        ["class HashSet", sourcesOf(Object.values(hashSetRegions(word, 4)))],
        ["struct Collection", sourcesOf(Object.values(collectionRegions(word, 4)))],
        ["class LinkedList", sourcesOf(Object.values(linkedListRegions(word, 4)))],
    ];
    const drifted: Record<string, string[]> = {};

    for (const [declaration, names] of containers) {
        const block = privateBlock(declaration);
        // The leading boundary rejects a longer name merely ending with this one — `headIndex` must not be satisfied by Collection's `_headIndex()`.
        const missing = names.filter((name) => !new RegExp(`(?<!\\w)${name}\\b`).test(block));
        if (missing.length) {
            drifted[declaration] = missing;
        }
    }

    expect(drifted).toEqual({});
});
