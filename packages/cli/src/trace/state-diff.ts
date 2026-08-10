// Turns a traced call's changed byte windows into the rows `qinit debug` and `qinit call --trace` show.
// Each window is resolved down to the field, element and member it covers, so a diff reads the way
// `qinit state` reads instead of as offsets and hex. What a container's internals are called, and where
// they sit, comes from the member tables in @qinit/proto/qpi-layout.
import { decodeOutput } from "@qinit/proto";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiType,
} from "@qinit/proto/contract-idl";
import {
  arrayGeometry,
  collectionMembers,
  hashMapMembers,
  hashSetMembers,
  linkedListMembers,
  type ContainerRegion,
  type MemberRole,
  type WordType,
} from "@qinit/proto/qpi-layout";
import type { DebugStateRegion } from "@qinit/core";
import {
  formatStateValue,
  hexToBytes,
  type StateField,
  type StateLine,
} from "./format";

// A diff row keeps both label forms: `label` is what the default view shows, `detail` the full resolved
// path. `internal` marks container bookkeeping a contract author never wrote, hidden until the full view.
export type StateDiffLine = StateLine & { detail: string; internal: boolean };

// Container bookkeeping is not in the IDL — its indices and counters are plain 64-bit words.
const word = (kind: AbiScalarKind, size = 8): AbiType => ({
  kind: AbiTypeKind.SCALAR,
  scalar: kind,
  size,
  align: 8,
  format: kind,
});
const WORD_TYPES: Record<WordType, AbiType> = {
  sint64: word(AbiScalarKind.SINT64),
  uint64: word(AbiScalarKind.UINT64),
  id: word(AbiScalarKind.ID, 32),
};
const SINT64 = WORD_TYPES.sint64;

// `payload` is a value the contract itself wrote, `count` a container's entry total, and `internal` the
// bookkeeping — occupation flags, list links, free-list heads — that only the full view shows.
type LeafClass = MemberRole;

// Two names per leaf: the resolved path through the container, and the shorter label the default view
// shows for it. They differ only where a path runs through container internals.
type Names = { path: string; short: string };

const child = (names: Names, suffix: string, shortSuffix = suffix): Names => ({
  path: names.path + suffix,
  short: names.short + shortSuffix,
});

// A decodable value at an absolute state offset, or packed bits to report one changed index at a time.
type Leaf = Names &
  ({ kind: "value"; cls: LeafClass; off: number; type: AbiType }
    | {
        kind: "bits";
        cls: LeafClass;
        off: number;
        size: number;
        bitsPer: number;
        count: number;
      });

const at = (
  names: Names,
  off: number,
  type: AbiType,
  cls: LeafClass = "payload",
): Leaf => ({ kind: "value", ...names, cls, off, type });

const bookkeeping = (names: Names, off: number, type: AbiType) => at(names, off, type, "internal");

// The member of `type` that byte `offset` (relative to `base`) falls in. Indexed collections always
// resolve per element; a struct stops as one row when `covered` says the region holds all of it.
function leafAt(
  names: Names,
  base: number,
  type: AbiType,
  offset: number,
  covered: (off: number, size: number) => boolean,
): Leaf {
  switch (type.kind) {
    case AbiTypeKind.STRUCT: {
      if (covered(base, type.size)) {
        return at(names, base, type);
      }

      const field = type.fields.find(
        (candidate) =>
          offset >= candidate.offset && offset < candidate.offset + candidate.size,
      );
      if (!field) {
        return at(names, base, type);
      }
      return leafAt(
        child(names, `.${field.name}`),
        base + field.offset,
        field.type,
        offset - field.offset,
        covered,
      );
    }

    case AbiTypeKind.ARRAY: {
      const { stride } = arrayGeometry(type.element, type.count);
      const index = Math.floor(offset / stride);
      const inner = offset - index * stride;
      const element = child(names, `[${index}]`);
      const elementBase = base + index * stride;
      if (inner >= type.element.size) {
        return at(element, elementBase, type.element);
      }
      return leafAt(element, elementBase, type.element, inner, covered);
    }

    case AbiTypeKind.HASH_MAP:
      return memberLeaf(
        names,
        base,
        offset,
        hashMapMembers(type.key, type.value, type.capacity),
        (tag) => (tag === "key" ? type.key : type.value),
        covered,
      );

    case AbiTypeKind.HASH_SET:
      return memberLeaf(
        names,
        base,
        offset,
        hashSetMembers(type.key, type.capacity),
        () => type.key,
        covered,
      );

    // Printing 256 bits twice to show one flip is the noise this whole module exists to remove.
    case AbiTypeKind.BIT_ARRAY:
      return bitsLeaf(names, base, type.size, 1, type.bitCount, "payload");

    case AbiTypeKind.COLLECTION:
      return memberLeaf(
        names,
        base,
        offset,
        collectionMembers(type.value, type.capacity),
        () => type.value,
        covered,
      );

    case AbiTypeKind.LINKED_LIST:
      return memberLeaf(
        names,
        base,
        offset,
        linkedListMembers(type.value, type.capacity),
        () => type.value,
        covered,
      );

    default:
      return at(names, base, type);
  }
}

// The member of a container that byte `offset` falls in, from the tables in @qinit/proto/qpi-layout.
// Matching takes the first member whose end passes the offset, so C padding belongs to the member that
// follows it and the resolved leaf always ends past `offset` — which is what keeps stateDiffLines moving.
function memberLeaf(
  names: Names,
  base: number,
  offset: number,
  regions: ContainerRegion[],
  idlType: (tag: "key" | "value") => AbiType,
  covered: (off: number, size: number) => boolean,
): Leaf {
  const region = regions.find((candidate) => offset < candidate.end) ??
    regions[regions.length - 1];

  if (region.kind === "flags") {
    return bitsLeaf(
      child(names, region.path),
      base + region.off,
      region.end - region.off,
      region.bitsPer,
      region.count,
      "internal",
    );
  }

  if (region.kind === "word") {
    return at(
      child(names, region.path, region.short),
      base + region.off,
      WORD_TYPES[region.type],
      region.role,
    );
  }

  const index = Math.floor((offset - region.off) / region.stride);
  const inner = offset - region.off - index * region.stride;
  const recordBase = base + region.off + index * region.stride;
  const record = child(
    names,
    `${region.path}[${index}]`,
    `${region.short}[${index}]`,
  );

  const found = region.members.find(
    (candidate) => inner < candidate.off + candidate.size,
  );
  if (!found) {
    return bookkeeping(record, recordBase, SINT64);
  }

  const named = child(record, found.path, found.short);
  return found.type === "key" || found.type === "value"
    ? leafAt(
        named,
        recordBase + found.off,
        idlType(found.type),
        Math.max(0, inner - found.off),
        covered,
      )
    : at(named, recordBase + found.off, WORD_TYPES[found.type], found.role);
}

const bitsLeaf = (
  names: Names,
  off: number,
  size: number,
  bitsPer: number,
  count: number,
  cls: LeafClass,
): Leaf => ({ kind: "bits", ...names, cls, off, size, bitsPer, count });

const allZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function renderValue(bytes: Uint8Array, type: AbiType): Promise<string> {
  if (allZero(bytes)) {
    return "0"; // matches how `qinit state` collapses an untouched element
  }

  const decoded = await decodeOutput(bytes, type);
  return typeof decoded === "object" && decoded !== null
    ? formatStateValue(decoded, type, true, true)
    : String(decoded);
}

// Occupation flags and BitArrays are packed, so report the indices that moved, not the raw words.
function bitRows(
  leaf: Extract<Leaf, { kind: "bits" }>,
  before: Uint8Array,
  after: Uint8Array,
): StateDiffLine[] {
  const rows: StateDiffLine[] = [];
  const valueAt = (bytes: Uint8Array, index: number) => {
    const bit = index * leaf.bitsPer;
    const byte = bytes[bit >> 3];
    if (byte === undefined) {
      return undefined;
    }
    const mask = (1 << leaf.bitsPer) - 1;
    return (byte >> (bit & 7)) & mask;
  };

  for (let index = 0; index < leaf.count; index++) {
    const from = valueAt(before, index);
    const to = valueAt(after, index);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    rows.push({
      label: `${leaf.short}[${index}]`,
      detail: `${leaf.path}[${index}]`,
      text: `${from} → ${to}`,
      filled: true,
      internal: leaf.cls === "internal",
    });
  }

  return rows;
}

// A value straddling two regions can only be decoded once they are one range — core reports per dirty
// page, so a record crossing a page boundary arrives split.
function joinedRegions(regions: DebugStateRegion[]): DebugStateRegion[] {
  const joined: DebugStateRegion[] = [];

  for (const region of [...regions].sort((left, right) => left.off - right.off)) {
    const last = joined[joined.length - 1];
    if (last && last.off + last.before.length / 2 === region.off) {
      last.before += region.before;
      last.after += region.after;
      continue;
    }

    joined.push({ ...region });
  }

  return joined;
}

// Every changed window, resolved and decoded. Regions may be minimal runs (a core node) or aligned
// windows (the simulator); a run that does not cover a whole value keeps its bytes rather than guessing.
export async function stateDiffLines(
  fields: StateField[],
  regions: DebugStateRegion[],
): Promise<StateDiffLine[]> {
  const rows: StateDiffLine[] = [];

  for (const region of joinedRegions(regions)) {
    const before = hexToBytes(region.before);
    const after = hexToBytes(region.after);
    const end = region.off + Math.min(before.length, after.length);
    let position = region.off;

    while (position < end) {
      const field = fields.find(
        (candidate) =>
          position >= candidate.off && position < candidate.off + candidate.size,
      );
      if (!field?.abi) {
        rows.push({
          label: `@${position}`,
          detail: `@${position}`,
          text: "(outside any known field)",
          filled: false,
          internal: false,
        });
        break;
      }

      const leaf = leafAt(
        { path: field.name, short: field.name },
        field.off,
        field.abi,
        position - field.off,
        (off, size) => off >= region.off && off + size <= end,
      );
      const slice = (bytes: Uint8Array, from: number, to: number) =>
        bytes.slice(from - region.off, to - region.off);

      if (leaf.kind === "bits") {
        const flagsEnd = Math.min(leaf.off + leaf.size, end);
        if (leaf.off >= region.off) {
          rows.push(
            ...bitRows(
              leaf,
              slice(before, leaf.off, flagsEnd),
              slice(after, leaf.off, flagsEnd),
            ),
          );
        }
        position = flagsEnd;
        continue;
      }

      const valueEnd = leaf.off + leaf.type.size;
      const visibleStart = Math.max(leaf.off, region.off);
      const visibleEnd = Math.min(valueEnd, end);
      const beforeBytes = slice(before, visibleStart, visibleEnd);
      const afterBytes = slice(after, visibleStart, visibleEnd);

      // A window carries unchanged bytes around the ones that moved; only the latter are worth a row.
      if (!bytesEqual(beforeBytes, afterBytes)) {
        const internal = leaf.cls === "internal";
        if (leaf.off >= region.off && valueEnd <= end) {
          const change = `${await renderValue(beforeBytes, leaf.type)} → ${await renderValue(afterBytes, leaf.type)}`;
          rows.push({
            label: leaf.short,
            detail: leaf.path,
            text: leaf.cls === "count" ? `${change} entries` : change,
            filled: true,
            internal,
          });
        } else {
          // A partial run: report the bytes that did change rather than invent the ones that did not.
          const inside = `+${visibleStart - leaf.off}`;
          rows.push({
            label: leaf.short + inside,
            detail: leaf.path + inside,
            text: `0x${toHex(beforeBytes)} → 0x${toHex(afterBytes)}`,
            filled: true,
            internal,
          });
        }
      }

      position = Math.max(valueEnd, position + 1);
    }
  }

  return rows;
}
