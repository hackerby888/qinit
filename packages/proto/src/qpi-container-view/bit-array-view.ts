import { AbiTypeKind, type AbiBitArray } from "../contract-idl";
import { bitAt, bitWordCount } from "../qpi-layout";
import {
  assertPositivePowerOfTwo,
  assertQpiSourceSize,
} from "./common";
import { readQpiBytes, type QpiByteSource } from "./source";

export interface QpiBitArrayEntry {
  index: number;
  value: 0 | 1;
}

export class QpiBitArrayView {
  readonly kind = AbiTypeKind.BIT_ARRAY;
  readonly capacity: number;

  constructor(
    readonly type: AbiBitArray,
    private readonly source: QpiByteSource,
  ) {
    this.capacity = type.bitCount;
    assertPositivePowerOfTwo(type.bitCount, "BitArray capacity");
    if (type.align !== 8 || type.size !== bitWordCount(type.bitCount) * 8) {
      throw new Error("BitArray ABI layout has an invalid size or alignment");
    }
    assertQpiSourceSize(source, type.size, "BitArray");
  }

  async get(index: number): Promise<0 | 1> {
    this.assertIndex(index);
    const byteOffset = Math.floor(index / 8);
    const bytes = await readQpiBytes(this.source, byteOffset, 1);
    return bitAt(bytes, index & 7) as 0 | 1;
  }

  async entries(): Promise<QpiBitArrayEntry[]> {
    const entries: QpiBitArrayEntry[] = [];
    let byteOffset = 0;
    while (byteOffset < this.type.size) {
      const length = Math.min(
        this.source.maxReadLength,
        this.type.size - byteOffset,
      );
      const bytes = await readQpiBytes(this.source, byteOffset, length);
      const firstBit = byteOffset * 8;
      const bitCount = Math.min(
        bytes.length * 8,
        this.capacity - firstBit,
      );
      for (let localBit = 0; localBit < bitCount; localBit++) {
        entries.push({
          index: firstBit + localBit,
          value: bitAt(bytes, localBit) as 0 | 1,
        });
      }
      byteOffset += length;
    }
    return entries;
  }

  private assertIndex(index: number): void {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.capacity
    ) {
      throw new RangeError(
        `BitArray index ${index} is outside 0..${this.capacity - 1}`,
      );
    }
  }
}
