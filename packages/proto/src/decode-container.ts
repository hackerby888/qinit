// Decode occupied QPI container entries from raw layouts and two-bit flags.
import { decodeOutput, structFieldOffsets, layoutOf } from "./abi-fmt";
import {
  collectionGeometry,
  hashMapGeometry,
  hashSetGeometry,
  occupationFlagAt,
  COLLECTION_POV_FMT,
} from "./qpi-layout";
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
  const geometry = hashMapGeometry(
    keyLayout,
    valueLayout,
    capacity,
  );
  const flags = buf.subarray(
    geometry.flagsOffset,
    geometry.flagsOffset + geometry.flagsBytes,
  );
  const out: MapEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (occupationFlagAt(flags, i) !== 1) continue;
    const e = i * geometry.recordStride;
    out.push({
      slot: i,
      key: await decodeOutput(buf.slice(e, e + keyLayout.size), keyFmt),
      value: await decodeOutput(
        buf.slice(
          e + geometry.valueOffset,
          e + geometry.valueOffset + valueLayout.size,
        ),
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
  const keyLayout = layoutOf(keyFmt);
  const geometry = hashSetGeometry(keyLayout, capacity);
  const flags = buf.subarray(
    geometry.flagsOffset,
    geometry.flagsOffset + geometry.flagsBytes,
  );
  const out: SetEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (occupationFlagAt(flags, i) !== 1) continue;
    out.push({
      slot: i,
      key: await decodeOutput(
        buf.slice(
          i * geometry.recordStride,
          i * geometry.recordStride + keyLayout.size,
        ),
        keyFmt,
      ),
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
  const valueLayout = layoutOf(valFmt);
  const geometry = collectionGeometry(valueLayout, capacity);
  const flags = buf.subarray(
    geometry.flagsOffset,
    geometry.flagsOffset + geometry.flagsBytes,
  );
  const pf = structFieldOffsets(povFmt); // [id, population, head, tail, bstRoot]
  const cap = BigInt(capacity);
  const valid = (x: bigint) => x >= 0n && x < cap;
  const out: CollEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (occupationFlagAt(flags, i) !== 1) continue;
    const povBase = geometry.povsOffset + i * geometry.povStride;
    const pov = await decodeOutput(buf.slice(povBase, povBase + pf[0].size), "id");
    let cur = sint64At(buf, povBase + pf[4].off); // bstRootIndex
    const stack: number[] = [];
    let guard = 0;
    while ((valid(cur) || stack.length) && guard++ < capacity * 2 + 4) {
      while (valid(cur) && guard++ < capacity * 2 + 4) {
        stack.push(Number(cur));
        cur = sint64At(
          buf,
          geometry.elementsOffset +
            Number(cur) * geometry.elementStride +
            geometry.priorityOffset +
            3 * 8,
        );
      } // go left
      if (!stack.length) break;
      const idx = stack.pop()!;
      const eb = geometry.elementsOffset + idx * geometry.elementStride;
      out.push({
        pov,
        value: await decodeOutput(buf.slice(eb, eb + valueLayout.size), valFmt),
        priority: sint64At(buf, eb + geometry.priorityOffset),
      });
      cur = sint64At(buf, eb + geometry.priorityOffset + 4 * 8); // go right
    }
  }
  return out;
}
