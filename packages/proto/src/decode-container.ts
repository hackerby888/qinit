// Decode occupied QPI container entries from raw layouts and two-bit flags.
import { decodeOutput, structFieldOffsets, layoutOf } from "./abi-fmt";
import { flagWordCount, COLLECTION_POV_FMT } from "./qpi-layout";
import { roundUp } from "@qinit/core";
import type { AbiType } from "./contract-idl";

export interface MapEntry {
  slot: number;
  key: unknown;
  value: unknown;
}
export interface SetEntry {
  slot: number;
  key: unknown;
}
export interface CollEntry {
  pov: unknown;
  value: unknown;
  priority: bigint;
}

const NULL_INDEX = -1n;
// 2-bit occupation flag for slot i (read the containing little-endian uint64).
function flagAt(buf: Uint8Array, flagsOff: number, i: number): number {
  const w = flagsOff + (i >> 5) * 8;
  if (w + 8 > buf.length) return 0;
  const word = new DataView(buf.buffer, buf.byteOffset + w, 8).getBigUint64(0, true);
  return Number((word >> BigInt((i & 31) * 2)) & 3n);
}
function sint64At(buf: Uint8Array, off: number): bigint {
  if (off < 0 || off + 8 > buf.length) return NULL_INDEX;
  return new DataView(buf.buffer, buf.byteOffset + off, 8).getBigInt64(0, true);
}

export async function decodeHashMap(
  buf: Uint8Array,
  keyFmt: string | AbiType,
  valFmt: string | AbiType,
  capacity: number,
): Promise<MapEntry[]> {
  const keyLayout = layoutOf(keyFmt);
  const valueLayout = layoutOf(valFmt);
  const valueOffset = roundUp(keyLayout.size, valueLayout.align);
  const stride = roundUp(
    valueOffset + valueLayout.size,
    Math.max(keyLayout.align, valueLayout.align),
  );
  const flagsOff = capacity * stride;
  const out: MapEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (flagAt(buf, flagsOff, i) !== 1) continue;
    const e = i * stride;
    out.push({
      slot: i,
      key: await decodeOutput(buf.slice(e, e + keyLayout.size), keyFmt),
      value: await decodeOutput(
        buf.slice(e + valueOffset, e + valueOffset + valueLayout.size),
        valFmt,
      ),
    });
  }
  return out;
}

export async function decodeHashSet(
  buf: Uint8Array,
  keyFmt: string | AbiType,
  capacity: number,
): Promise<SetEntry[]> {
  const kl = layoutOf(keyFmt);
  const stride = roundUp(kl.size, kl.align);
  const flagsOff = capacity * stride;
  const out: SetEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (flagAt(buf, flagsOff, i) !== 1) continue;
    out.push({
      slot: i,
      key: await decodeOutput(buf.slice(i * stride, i * stride + kl.size), keyFmt),
    });
  }
  return out;
}

// Collection<T,L>: PoV{ id value; uint64 population; sint64 head, tail, bstRoot } _povs[L] + 2-bit pov flags +
// Element{ T value; sint64 priority, povIndex, bstParent, bstLeft, bstRight } _elements[L] + 2 counters.
export async function decodeCollection(
  buf: Uint8Array,
  valFmt: string | AbiType,
  capacity: number,
): Promise<CollEntry[]> {
  const povFmt = COLLECTION_POV_FMT;
  const povStride = roundUp(layoutOf(povFmt).size, layoutOf(povFmt).align); // 64
  const valueLayout = layoutOf(valFmt);
  const priorityOffset = roundUp(valueLayout.size, 8);
  const elemStride = roundUp(
    priorityOffset + 5 * 8,
    Math.max(valueLayout.align, 8),
  );
  const flagsOff = capacity * povStride;
  const elemsOff = flagsOff + flagWordCount(capacity) * 8;
  const pf = structFieldOffsets(povFmt); // [id, population, head, tail, bstRoot]
  const cap = BigInt(capacity);
  const valid = (x: bigint) => x >= 0n && x < cap;
  const out: CollEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (flagAt(buf, flagsOff, i) !== 1) continue;
    const povBase = i * povStride;
    const pov = await decodeOutput(buf.slice(povBase, povBase + pf[0].size), "id");
    let cur = sint64At(buf, povBase + pf[4].off); // bstRootIndex
    const stack: number[] = [];
    let guard = 0;
    while ((valid(cur) || stack.length) && guard++ < capacity * 2 + 4) {
      while (valid(cur) && guard++ < capacity * 2 + 4) {
        stack.push(Number(cur));
        cur = sint64At(buf, elemsOff + Number(cur) * elemStride + priorityOffset + 3 * 8);
      } // go left
      if (!stack.length) break;
      const idx = stack.pop()!;
      const eb = elemsOff + idx * elemStride;
      out.push({
        pov,
        value: await decodeOutput(buf.slice(eb, eb + valueLayout.size), valFmt),
        priority: sint64At(buf, eb + priorityOffset),
      });
      cur = sint64At(buf, eb + priorityOffset + 4 * 8); // go right
    }
  }
  return out;
}
