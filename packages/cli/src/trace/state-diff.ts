// Turns a traced call's changed byte windows into the rows `qinit debug` and `qinit call --trace` show.
// Each window is resolved down to the field, element and member it covers, so a diff reads the way
// `qinit state` reads instead of as offsets and hex.
import { decodeOutput } from "@qinit/proto";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiType,
} from "@qinit/proto/contract-idl";
import {
  arrayGeometry,
  collectionGeometry,
  hashMapGeometry,
  hashSetGeometry,
  linkedListGeometry,
} from "@qinit/proto/qpi-layout";
import type { DebugStateRegion } from "@qinit/core";
import {
  formatStateValue,
  hexToBytes,
  type StateField,
  type StateLine,
} from "./format";

const MAX_ROWS = 40;

// Container bookkeeping is not in the IDL — its indices and counters are plain 64-bit words.
const word = (kind: AbiScalarKind, size = 8): AbiType => ({
  kind: AbiTypeKind.SCALAR,
  scalar: kind,
  size,
  align: 8,
  format: kind,
});
const SINT64 = word(AbiScalarKind.SINT64);
const UINT64 = word(AbiScalarKind.UINT64);
const ID = word(AbiScalarKind.ID, 32);

// A decodable value at an absolute state offset, or packed bits to report one changed index at a time.
type Leaf =
  | { kind: "value"; path: string; off: number; type: AbiType }
  | {
      kind: "bits";
      path: string;
      off: number;
      size: number;
      bitsPer: number;
      count: number;
    };

const at = (path: string, off: number, type: AbiType): Leaf => ({
  kind: "value",
  path,
  off,
  type,
});

// The member of `type` that byte `offset` (relative to `base`) falls in. Indexed collections always
// resolve per element; a struct stops as one row when `covered` says the region holds all of it.
function leafAt(
  path: string,
  base: number,
  type: AbiType,
  offset: number,
  covered: (off: number, size: number) => boolean,
): Leaf {
  switch (type.kind) {
    case AbiTypeKind.STRUCT: {
      if (covered(base, type.size)) {
        return at(path, base, type);
      }

      const field = type.fields.find(
        (candidate) =>
          offset >= candidate.offset && offset < candidate.offset + candidate.size,
      );
      if (!field) {
        return at(path, base, type);
      }
      return leafAt(
        `${path}.${field.name}`,
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
      const elementPath = `${path}[${index}]`;
      const elementBase = base + index * stride;
      if (inner >= type.element.size) {
        return at(elementPath, elementBase, type.element);
      }
      return leafAt(elementPath, elementBase, type.element, inner, covered);
    }

    case AbiTypeKind.HASH_MAP: {
      const geometry = hashMapGeometry(type.key, type.value, type.capacity);
      if (offset < type.capacity * geometry.recordStride) {
        const slot = Math.floor(offset / geometry.recordStride);
        const inner = offset - slot * geometry.recordStride;
        const slotPath = `${path}.slot[${slot}]`;
        const slotBase = base + slot * geometry.recordStride;
        if (inner < type.key.size) {
          return leafAt(`${slotPath}.key`, slotBase, type.key, inner, covered);
        }
        return leafAt(
          `${slotPath}.value`,
          slotBase + geometry.valueOffset,
          type.value,
          Math.max(0, inner - geometry.valueOffset),
          covered,
        );
      }
      if (offset < geometry.flagsOffset + geometry.flagsBytes) {
        return flagsLeaf(path, base + geometry.flagsOffset, geometry.flagsBytes, 2, type.capacity);
      }
      return counterLeaf(path, base, offset, geometry.populationOffset);
    }

    case AbiTypeKind.HASH_SET: {
      const geometry = hashSetGeometry(type.key, type.capacity);
      if (offset < type.capacity * geometry.recordStride) {
        const slot = Math.floor(offset / geometry.recordStride);
        const inner = offset - slot * geometry.recordStride;
        return leafAt(
          `${path}.slot[${slot}]`,
          base + slot * geometry.recordStride,
          type.key,
          inner,
          covered,
        );
      }
      if (offset < geometry.flagsOffset + geometry.flagsBytes) {
        return flagsLeaf(path, base + geometry.flagsOffset, geometry.flagsBytes, 2, type.capacity);
      }
      return counterLeaf(path, base, offset, geometry.populationOffset);
    }

    // Printing 256 bits twice to show one flip is the noise this whole module exists to remove.
    case AbiTypeKind.BIT_ARRAY:
      return bitsLeaf(path, base, type.size, 1, type.bitCount);

    case AbiTypeKind.COLLECTION:
      return collectionLeaf(path, base, type, offset, covered);

    case AbiTypeKind.LINKED_LIST:
      return linkedListLeaf(path, base, type, offset, covered);

    default:
      return at(path, base, type);
  }
}

const bitsLeaf = (
  path: string,
  off: number,
  size: number,
  bitsPer: number,
  count: number,
): Leaf => ({ kind: "bits", path, off, size, bitsPer, count });

const flagsLeaf = (path: string, off: number, size: number, bitsPer: number, capacity: number) =>
  bitsLeaf(`${path}._occupationFlags`, off, size, bitsPer, capacity);

// Both hash containers end with population followed by the removal counter.
function counterLeaf(
  path: string,
  base: number,
  offset: number,
  populationOffset: number,
): Leaf {
  return offset < populationOffset + 8
    ? at(`${path}._population`, base + populationOffset, UINT64)
    : at(`${path}._markRemovalCounter`, base + populationOffset + 8, UINT64);
}

function collectionLeaf(
  path: string,
  base: number,
  type: Extract<AbiType, { kind: AbiTypeKind.COLLECTION }>,
  offset: number,
  covered: (off: number, size: number) => boolean,
): Leaf {
  const geometry = collectionGeometry(type.value, type.capacity);

  if (offset < geometry.flagsOffset) {
    const index = Math.floor(offset / geometry.povStride);
    const inner = offset - index * geometry.povStride;
    const povPath = `${path}._povs[${index}]`;
    const povBase = base + index * geometry.povStride;
    const member = ([
      [geometry.povValueOffset, "value", 32],
      [geometry.povPopulationOffset, "population", 8],
      [geometry.povHeadOffset, "head", 8],
      [geometry.povTailOffset, "tail", 8],
      [geometry.povBstRootOffset, "bstRoot", 8],
    ] as const).find(([start, , size]) => inner >= start && inner < start + size);

    return member
      ? at(
          `${povPath}.${member[1]}`,
          povBase + member[0],
          member[1] === "value" ? ID : member[1] === "population" ? UINT64 : SINT64,
        )
      : at(povPath, povBase, SINT64);
  }

  if (offset < geometry.elementsOffset) {
    return flagsLeaf(path, base + geometry.flagsOffset, geometry.flagsBytes, 2, type.capacity);
  }

  if (offset < geometry.populationOffset) {
    const relative = offset - geometry.elementsOffset;
    const index = Math.floor(relative / geometry.elementStride);
    const inner = relative - index * geometry.elementStride;
    const elementPath = `${path}._elements[${index}]`;
    const elementBase = base + geometry.elementsOffset + index * geometry.elementStride;
    if (inner < type.value.size) {
      return leafAt(`${elementPath}.value`, elementBase, type.value, inner, covered);
    }

    const member = ([
      [geometry.elementPriorityOffset, "priority"],
      [geometry.elementPovIndexOffset, "povIndex"],
      [geometry.elementBstParentOffset, "bstParent"],
      [geometry.elementBstLeftOffset, "bstLeft"],
      [geometry.elementBstRightOffset, "bstRight"],
    ] as const).find(([start]) => inner >= start && inner < start + 8);

    return member
      ? at(`${elementPath}.${member[1]}`, elementBase + member[0], SINT64)
      : at(elementPath, elementBase, SINT64);
  }

  return counterLeaf(path, base, offset, geometry.populationOffset);
}

function linkedListLeaf(
  path: string,
  base: number,
  type: Extract<AbiType, { kind: AbiTypeKind.LINKED_LIST }>,
  offset: number,
  covered: (off: number, size: number) => boolean,
): Leaf {
  const geometry = linkedListGeometry(type.value, type.capacity);

  if (offset < geometry.flagsOffset) {
    const index = Math.floor(offset / geometry.nodeStride);
    const inner = offset - index * geometry.nodeStride;
    const nodePath = `${path}._nodes[${index}]`;
    const nodeBase = base + index * geometry.nodeStride;
    if (inner < type.value.size) {
      return leafAt(`${nodePath}.value`, nodeBase, type.value, inner, covered);
    }
    return inner < geometry.prevOffset
      ? at(`${nodePath}.next`, nodeBase + geometry.nextOffset, SINT64)
      : at(`${nodePath}.prev`, nodeBase + geometry.prevOffset, SINT64);
  }

  if (offset < geometry.headOffset) {
    return flagsLeaf(path, base + geometry.flagsOffset, geometry.flagsBytes, 1, type.capacity);
  }

  const member = ([
    [geometry.headOffset, "_head", SINT64],
    [geometry.tailOffset, "_tail", SINT64],
    [geometry.freeHeadOffset, "_freeHead", SINT64],
    [geometry.nextUnusedOffset, "_nextUnused", UINT64],
    [geometry.populationOffset, "_population", UINT64],
  ] as const).find(([start]) => offset >= start && offset < start + 8);

  return member
    ? at(`${path}.${member[1]}`, base + member[0], member[2])
    : at(`${path}._population`, base + geometry.populationOffset, UINT64);
}

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
): StateLine[] {
  const rows: StateLine[] = [];
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
      label: `${leaf.path}[${index}]`,
      text: `${from} → ${to}`,
      filled: true,
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
): Promise<StateLine[]> {
  const rows: StateLine[] = [];

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
          text: "(outside any known field)",
          filled: false,
        });
        break;
      }

      const leaf = leafAt(
        field.name,
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
        if (leaf.off >= region.off && valueEnd <= end) {
          rows.push({
            label: leaf.path,
            text: `${await renderValue(beforeBytes, leaf.type)} → ${await renderValue(afterBytes, leaf.type)}`,
            filled: true,
          });
        } else {
          // A partial run: report the bytes that did change rather than invent the ones that did not.
          rows.push({
            label: `${leaf.path}+${visibleStart - leaf.off}`,
            text: `0x${toHex(beforeBytes)} → 0x${toHex(afterBytes)}`,
            filled: true,
          });
        }
      }

      position = Math.max(valueEnd, position + 1);
    }
  }

  if (rows.length > MAX_ROWS) {
    const dropped = rows.length - MAX_ROWS;
    rows.length = MAX_ROWS;
    rows.push({ label: "", text: `… +${dropped} more`, filled: false });
  }

  return rows;
}
