import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_PATH } from "../../../../test-utils/paths";

type CoverageManifest = Record<string, Record<string, string>>;

export const CONTAINER_COVERAGE: CoverageManifest = {
  Array: {
    "capacity/0": "scalar and aggregate capacity boundaries",
    "get/1": "wrapped scalar and aggregate reads",
    "set/2": "wrapped scalar and aggregate writes",
    "setMem/1": "same-size source-backed memory copy",
    "setAll/1": "full-capacity fill",
    "setRange/3": "valid, empty, wrapping, and invalid ranges",
    "rangeEquals/3": "matching, empty, and invalid ranges",
    "operator=/1": "aggregate assignment",
    "Array/1": "copy construction body and copy semantics",
    "Array/0": "default construction in state and locals",
  },
  BitArray: {
    "capacity/0": "capacities 2, 64, 128, and 4096",
    "get/1": "word edges, final bit, and wrapped indices",
    "set/2": "set and clear across word edges",
    "setMem/1": "same-size raw memory copy",
    "setAll/1": "all-zero and all-one fills",
    "operator==/1": "equal bit arrays",
    "operator!=/1": "unequal bit arrays",
  },
  HashMap: {
    "HashMap/0": "zero/default state",
    "capacity/0": "fixed full-capacity boundary",
    "population/0": "empty, filled, removed, and reset states",
    "contains/1": "present and missing keys",
    "get/2": "present and missing value output",
    "getElementIndex/1": "custom-hash collisions and missing keys",
    "isEmptySlot/1": "occupied and invalid indices",
    "nextElementIndex/1": "complete iteration from NULL_INDEX",
    "key/1": "occupied iteration slots",
    "value/1": "overwritten and collided values",
    "set/2": "overwrite, collisions, wrap-around, full map, and marked reuse",
    "removeByIndex/1": "occupied and invalid indices",
    "removeByKey/1": "present and missing keys",
    "needsCleanup/1": "default and explicit thresholds",
    "cleanupIfNeeded/1": "threshold-triggered cleanup",
    "cleanup/0": "complete marked-slot compaction",
    "replace/2": "present and missing keys",
    "reset/0": "empty-state byte reset",
  },
  HashSet: {
    "HashSet/0": "zero/default state",
    "capacity/0": "fixed full-capacity boundary",
    "population/0": "empty, filled, removed, and reset states",
    "contains/1": "present and missing keys",
    "getElementIndex/1": "custom-hash collisions and missing keys",
    "isEmptySlot/1": "occupied and invalid indices",
    "nextElementIndex/1": "complete iteration from NULL_INDEX",
    "key/1": "occupied iteration slots",
    "add/1": "duplicates, collisions, wrap-around, full set, and marked reuse",
    "removeByIndex/1": "occupied and invalid indices",
    "remove/1": "present and missing keys",
    "needsCleanup/1": "default and explicit thresholds",
    "cleanupIfNeeded/1": "threshold-triggered cleanup",
    "cleanup/0": "complete marked-slot compaction",
    "reset/0": "empty-state byte reset",
  },
  Collection: {
    "add/3": "colliding PoVs, equal and negative priorities, full capacity, and rebuild",
    "capacity/0": "fixed full-capacity boundary",
    "needsCleanup/1": "default and explicit thresholds",
    "cleanupIfNeeded/1": "threshold-triggered PoV cleanup",
    "cleanup/0": "marked PoV cleanup and state rebuild",
    "element/1": "valid element placement from the native oracle",
    "headIndex/1": "unfiltered queue head",
    "headIndex/2": "maximum-priority filtered head",
    "nextElementIndex/1": "forward traversal",
    "population/0": "overall population",
    "population/1": "per-PoV population",
    "pov/1": "element PoV and invalid index",
    "prevElementIndex/1": "reverse traversal",
    "priority/1": "equal and negative priorities",
    "remove/1": "leaf, root, one-child, two-child, and invalid removal",
    "replace/2": "valid and invalid replacement",
    "reset/0": "empty-state byte reset",
    "tailIndex/1": "unfiltered queue tail",
    "tailIndex/2": "minimum-priority filtered tail",
  },
  LinkedList: {
    "capacity/0": "fixed full-capacity boundary",
    "population/0": "empty, singleton, full, removed, and reset states",
    "headIndex/0": "empty, singleton, and multi-node head",
    "tailIndex/0": "empty, singleton, and multi-node tail",
    "nextElementIndex/1": "forward traversal and invalid index",
    "prevElementIndex/1": "reverse traversal and invalid index",
    "element/1": "head, tail, and middle values",
    "isEmptySlot/1": "occupied, free, and out-of-range slots",
    "addHead/1": "empty, populated, full, and free-list reuse",
    "addTail/1": "empty, populated, full, and free-list reuse",
    "insertAfter/2": "head, middle, tail, full, and invalid insertion",
    "insertBefore/2": "head, middle, tail, full, and invalid insertion",
    "remove/1": "head, middle, tail, singleton, and invalid removal",
    "replace/2": "valid and invalid replacement",
    "reset/0": "empty-state byte reset",
  },
};

function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "(") depth++;
    if (source[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function argumentCount(source: string): number {
  if (!source.trim() || source.trim() === "void") return 0;
  let angle = 0,
    paren = 0,
    brace = 0,
    count = 1;
  for (const char of source) {
    if (char === "<") angle++;
    else if (char === ">") angle--;
    else if (char === "(") paren++;
    else if (char === ")") paren--;
    else if (char === "{") brace++;
    else if (char === "}") brace--;
    else if (char === "," && angle === 0 && paren === 0 && brace === 0) count++;
  }
  return count;
}

export function publicMethodSurface(header: string, family: string): string[] {
  const declaration = new RegExp(`\\b(?:struct|class)\\s+${family}\\b[^;{]*\\{`, "m").exec(header);
  if (!declaration) throw new Error(`${family} declaration not found`);
  const open = declaration.index + declaration[0].lastIndexOf("{");
  const isStruct = /\bstruct\s/.test(declaration[0]);
  let depth = 1;
  let access = isStruct ? "public" : "private";
  const methods = new Set<string>();

  for (let index = open + 1; index < header.length && depth > 0; index++) {
    const char = header[index];
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;

    const rest = header.slice(index);
    const accessMatch = /^(public|private|protected)\s*:/.exec(rest);
    if (accessMatch) {
      access = accessMatch[1];
      index += accessMatch[0].length - 1;
      continue;
    }
    if (access !== "public" || char !== "(") continue;

    const before = header.slice(Math.max(open + 1, index - 120), index);
    const nameMatch = /(operator\s*(?:==|!=|=)|~?[A-Za-z_]\w*)\s*$/.exec(before);
    if (
      !nameMatch ||
      ["if", "for", "while", "switch", "sizeof", "static_assert"].includes(nameMatch[1])
    )
      continue;
    const close = matchingParen(header, index);
    if (close < 0) break;
    const after = header.slice(close + 1, close + 100);
    if (!/^\s*(?:const\s*)?(?:noexcept\s*)?(?:=\s*(?:default|delete)\s*)?[{;]/.test(after))
      continue;
    const name = nameMatch[1].replace(/\s+/g, "");
    methods.add(`${name}/${argumentCount(header.slice(index + 1, close))}`);
    index = close;
  }
  return [...methods].sort();
}

describe("QPI container public API coverage manifest", () => {
  const liveHeader = readFileSync(join(CORE_PATH, "src", "contracts", "qpi.h"), "utf8");
  for (const family of Object.keys(CONTAINER_COVERAGE)) {
    test(`${family} manifest exactly matches live qpi.h`, () => {
      expect(Object.keys(CONTAINER_COVERAGE[family]).sort()).toEqual(
        publicMethodSurface(liveHeader, family),
      );
      expect(
        Object.values(CONTAINER_COVERAGE[family]).every((description) => description.length > 0),
      ).toBe(true);
    });
  }
});
