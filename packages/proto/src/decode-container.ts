// Logical-entry decode for QPI containers. Given a container's raw bytes + its element key/value formats +
// capacity, walk the 2-bit occupation flags and emit the OCCUPIED entries (key/value decoded). On-wire layout
// mirrors qpi.h: HashMap = Element{key,value}[L] then uint64 _occupationFlags[ceil(2L/64)] then _population,
// _markRemovalCounter; HashSet = key[L] + the same flags. Flag for slot i = (flags[i>>5] >> ((i&31)*2)) & 3,
// where 1 = occupied (00 empty, 10 marked-for-removal -> both excluded). qpi_hash_map_impl.h:38/130/186.
// (Collection's PoV + per-PoV BST layout is not decoded here.)
import { decodeOutput, structFieldOffsets, layoutOf } from "./abi-fmt";
import { flagWordCount, hashMapElemFmt, collectionElemFmt, COLLECTION_POV_FMT } from "./qpi-layout";

const roundUp = (o: number, a: number) => (a <= 1 ? o : Math.ceil(o / a) * a);

export interface MapEntry { slot: number; key: unknown; value: unknown; }
export interface SetEntry { slot: number; key: unknown; }
export interface CollEntry { pov: unknown; value: unknown; priority: bigint; }

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

export async function decodeHashMap(buf: Uint8Array, keyFmt: string, valFmt: string, capacity: number): Promise<MapEntry[]> {
  const elemFmt = hashMapElemFmt(keyFmt, valFmt);
  const el = layoutOf(elemFmt); const stride = roundUp(el.size, el.align);
  const [kf, vf] = structFieldOffsets(elemFmt);            // {off,size} of key, value within the element
  const flagsOff = capacity * stride;
  const out: MapEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (flagAt(buf, flagsOff, i) !== 1) continue;
    const e = i * stride;
    out.push({
      slot: i,
      key: await decodeOutput(buf.slice(e + kf.off, e + kf.off + kf.size), keyFmt),
      value: await decodeOutput(buf.slice(e + vf.off, e + vf.off + vf.size), valFmt),
    });
  }
  return out;
}

export async function decodeHashSet(buf: Uint8Array, keyFmt: string, capacity: number): Promise<SetEntry[]> {
  const kl = layoutOf(keyFmt); const stride = roundUp(kl.size, kl.align);
  const flagsOff = capacity * stride;
  const out: SetEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (flagAt(buf, flagsOff, i) !== 1) continue;
    out.push({ slot: i, key: await decodeOutput(buf.slice(i * stride, i * stride + kl.size), keyFmt) });
  }
  return out;
}

// Collection<T,L>: PoV{ id value; uint64 population; sint64 head, tail, bstRoot } _povs[L] + 2-bit pov flags +
// Element{ T value; sint64 priority, povIndex, bstParent, bstLeft, bstRight } _elements[L] + 2 counters.
// For each occupied PoV, in-order-traverse its priority BST (left,node,right). qpi stores higher priority on
// the left, so in-order yields priority-queue order: head first = highest priority.
export async function decodeCollection(buf: Uint8Array, valFmt: string, capacity: number): Promise<CollEntry[]> {
  const povFmt = COLLECTION_POV_FMT;
  const elemFmt = collectionElemFmt(valFmt);
  const povStride = roundUp(layoutOf(povFmt).size, layoutOf(povFmt).align);     // 64
  const elemStride = roundUp(layoutOf(elemFmt).size, layoutOf(elemFmt).align);
  const flagsOff = capacity * povStride;
  const elemsOff = flagsOff + flagWordCount(capacity) * 8;
  const pf = structFieldOffsets(povFmt);    // [id, population, head, tail, bstRoot]
  const ef = structFieldOffsets(elemFmt);   // [value, priority, povIndex, bstParent, bstLeft, bstRight]
  const cap = BigInt(capacity);
  const valid = (x: bigint) => x >= 0n && x < cap;
  const out: CollEntry[] = [];
  for (let i = 0; i < capacity; i++) {
    if (flagAt(buf, flagsOff, i) !== 1) continue;
    const povBase = i * povStride;
    const pov = await decodeOutput(buf.slice(povBase, povBase + pf[0].size), "id");
    let cur = sint64At(buf, povBase + pf[4].off);          // bstRootIndex
    const stack: number[] = []; let guard = 0;
    while ((valid(cur) || stack.length) && guard++ < capacity * 2 + 4) {
      while (valid(cur) && guard++ < capacity * 2 + 4) { stack.push(Number(cur)); cur = sint64At(buf, elemsOff + Number(cur) * elemStride + ef[4].off); } // go left
      if (!stack.length) break;
      const idx = stack.pop()!; const eb = elemsOff + idx * elemStride;
      out.push({ pov, value: await decodeOutput(buf.slice(eb + ef[0].off, eb + ef[0].off + ef[0].size), valFmt), priority: sint64At(buf, eb + ef[1].off) });
      cur = sint64At(buf, eb + ef[5].off);                 // go right
    }
  }
  return out;
}
