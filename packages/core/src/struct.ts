// Zero-copy struct-view kit: a struct is declared as a list of primitive codecs and `defineStruct` derives
// every field offset + the struct size the way the C compiler does — summing field sizes and inserting

// ---- codec combinator: a struct is composed from these primitives; offsets/sizes are derived, never typed. ----
export interface Backing {
  readonly bytes: Uint8Array;
  readonly dv: DataView;
}

export interface Codec<T> {
  readonly size: number;
  readonly align: number;
  read(v: Backing, off: number): T;
  write(v: Backing, off: number, val: T): void;
}

export const u8: Codec<number> = {
  size: 1,
  align: 1,
  read(v, o) {
    return v.dv.getUint8(o);
  },
  write(v, o, x) {
    v.dv.setUint8(o, x & 0xff);
  },
};

export const u16: Codec<number> = {
  size: 2,
  align: 2,
  read(v, o) {
    return v.dv.getUint16(o, true);
  },
  write(v, o, x) {
    v.dv.setUint16(o, x & 0xffff, true);
  },
};

// the 3-byte little-endian size field of RequestResponseHeader (header.h)
export const u24: Codec<number> = {
  size: 3,
  align: 1,
  read(v, o) {
    return v.dv.getUint8(o) | (v.dv.getUint8(o + 1) << 8) | (v.dv.getUint8(o + 2) << 16);
  },
  write(v, o, x) {
    v.dv.setUint8(o, x & 0xff);
    v.dv.setUint8(o + 1, (x >> 8) & 0xff);
    v.dv.setUint8(o + 2, (x >> 16) & 0xff);
  },
};

export const u32: Codec<number> = {
  size: 4,
  align: 4,
  read(v, o) {
    return v.dv.getUint32(o, true);
  },
  write(v, o, x) {
    v.dv.setUint32(o, x >>> 0, true);
  },
};

export const i64: Codec<bigint> = {
  size: 8,
  align: 8,
  read(v, o) {
    return v.dv.getBigInt64(o, true);
  },
  write(v, o, x) {
    v.dv.setBigInt64(o, x, true);
  },
};

export const i16: Codec<number> = {
  size: 2,
  align: 2,
  read(v, o) {
    return v.dv.getInt16(o, true);
  },
  write(v, o, x) {
    v.dv.setInt16(o, x, true);
  },
};

export const i32: Codec<number> = {
  size: 4,
  align: 4,
  read(v, o) {
    return v.dv.getInt32(o, true);
  },
  write(v, o, x) {
    v.dv.setInt32(o, x, true);
  },
};

export const u64: Codec<bigint> = {
  size: 8,
  align: 8,
  read(v, o) {
    return v.dv.getBigUint64(o, true);
  },
  write(v, o, x) {
    v.dv.setBigUint64(o, x, true);
  },
};

// a fixed-length byte field (e.g. signature, an id, an asset name) — alignment 1, returns a zero-copy window
export const blob = (n: number): Codec<Uint8Array> => ({
  size: n,
  align: 1,
  read(v, o) {
    return v.bytes.subarray(o, o + n);
  },
  write(v, o, val) {
    v.bytes.set(val.subarray(0, n), o);
  },
});

// explicit padding — an escape hatch for #pragma pack structs and for the reserved gaps in fixed ABI headers
// (e.g. the unused words of QpiContext); the natural-alignment emulation makes it unnecessary for structs whose
export const pad = (n: number): Codec<void> => ({
  size: n,
  align: 1,
  read() {
    return undefined;
  },
  write() {
    return undefined;
  },
});

// an indexed array field (TickData.transactionDigests / .contractFees) — `.at(i)` / `.set(i, value)`.
export class ArrayView<T> {
  readonly length: number;
  private readonly v: Backing;
  private readonly base: number;
  private readonly elem: Codec<T>;

  constructor(v: Backing, base: number, elem: Codec<T>, length: number) {
    this.v = v;
    this.base = base;
    this.elem = elem;
    this.length = length;
  }

  at(i: number): T {
    return this.elem.read(this.v, this.base + i * this.elem.size);
  }

  set(i: number, val: T | Uint8Array): void {
    this.elem.write(this.v, this.base + i * this.elem.size, val as T);
  }
}

export const array = <T>(elem: Codec<T>, n: number): Codec<ArrayView<T>> => ({
  size: elem.size * n,
  align: elem.align,
  read(v, o) {
    return new ArrayView<T>(v, o, elem, n);
  },
  write() {
    throw new Error("assign array elements via .set(i, value)");
  },
});

// an embedded struct field (e.g. RespondEntity's EntityRecord, PreManagementRightsTransfer's Asset): the getter
// returns a zero-copy view of the embedded struct over the parent buffer, so callers mutate it in place. align
export const sub = <T extends { bytes: Uint8Array }>(
  klass: { SIZE: number; wrap(buf: Uint8Array, off?: number): T },
  align = 8,
): Codec<T> => ({
  size: klass.SIZE,
  align,
  read(v, o) {
    return klass.wrap(v.bytes, o);
  },
  write(v, o, val) {
    v.bytes.set(val.bytes.subarray(0, klass.SIZE), o);
  },
});

export const roundUp = (n: number, align: number): number => (n + align - 1) & ~(align - 1);

// ---- shared view base: a zero-copy window plus its DataView. ----
export abstract class View implements Backing {
  readonly bytes: Uint8Array;
  readonly dv: DataView;

  protected constructor(buf: Uint8Array, off: number, size: number) {
    this.bytes = buf.subarray(off, off + size);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }
}

export type FieldType<C> = C extends Codec<infer T> ? T : never;
export type StructFields<S> = { [K in keyof S]: FieldType<S[K]> };

// A live struct view: every wire field as a read/write property (writes go straight through to `.bytes`), plus
// `.clone()` for a detached copy you can mutate without touching the original buffer.
export type StructInstance<S extends Record<string, Codec<any>>> = View &
  StructFields<S> & { clone(): StructInstance<S> };

export interface StructClass<S extends Record<string, Codec<any>>> {
  new (buf: Uint8Array, off?: number): StructInstance<S>;
  readonly SIZE: number;
  readonly OFFSETS: { [K in keyof S]: number };
  wrap(buf: Uint8Array, off?: number): StructInstance<S>;
  alloc(): StructInstance<S>;
}

// Build a struct view class from a field list, emulating the C compiler's natural-alignment layout: each field
// is placed at the next offset aligned to its codec's alignment, and SIZE is rounded up to the struct's max
export function defineStruct<S extends Record<string, Codec<any>>>(
  name: string,
  fields: S,
  opts: { packed?: boolean } = {},
): StructClass<S> {
  const packed = opts.packed ?? false;
  const keys = Object.keys(fields) as (keyof S & string)[];
  const offsets = {} as { [K in keyof S]: number };

  let cursor = 0;
  let structAlign = 1;
  for (const key of keys) {
    const codec = fields[key];
    const align = packed ? 1 : codec.align;
    cursor = roundUp(cursor, align);
    offsets[key] = cursor;
    cursor += codec.size;
    if (align > structAlign) {
      structAlign = align;
    }
  }
  const size = roundUp(cursor, packed ? 1 : structAlign);

  class Struct extends View {
    constructor(buf: Uint8Array, off = 0) {
      super(buf, off, size);
    }

    // Detached copy: a fresh size-byte buffer with the same contents. Mutating the clone never touches the
    // original (its signature/digest stay valid); re-sign the clone if you need it valid after edits.
    clone(): Struct {
      return new Struct(this.bytes.slice());
    }
  }

  for (const key of keys) {
    const codec = fields[key];
    const off = offsets[key];
    Object.defineProperty(Struct.prototype, key, {
      get(this: View) {
        return codec.read(this, off);
      },
      set(this: View, val: unknown) {
        codec.write(this, off, val as never);
      },
      enumerable: true,
      configurable: true,
    });
  }

  Object.defineProperty(Struct, "name", { value: name });
  const klass = Struct as unknown as {
    SIZE: number;
    OFFSETS: typeof offsets;
    wrap(buf: Uint8Array, off?: number): Struct;
    alloc(): Struct;
  };
  klass.SIZE = size;
  klass.OFFSETS = offsets;
  klass.wrap = (buf: Uint8Array, off = 0) => new Struct(buf, off);
  klass.alloc = () => new Struct(new Uint8Array(size));

  return Struct as unknown as StructClass<S>;
}
