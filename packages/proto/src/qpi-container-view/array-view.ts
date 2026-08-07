import { roundUp } from "@qinit/core";
import { AbiTypeKind, type AbiArray } from "../contract-idl";
import { assertQpiSourceSize, decodeSourceValue } from "./common";
import {
  qpiBorrowedSource,
  readQpiBytes,
  type QpiByteSource,
} from "./source";

export interface QpiArrayEntry {
  index: number;
  value: unknown;
  isZeroBytes: boolean;
}

export class QpiArrayView {
  readonly kind = AbiTypeKind.ARRAY;
  readonly capacity: number;

  private readonly stride: number;

  constructor(
    readonly type: AbiArray,
    private readonly source: QpiByteSource,
  ) {
    this.capacity = type.count;
    this.stride = Math.max(
      1,
      roundUp(type.element.size, type.element.align),
    );
    if (
      type.align !== type.element.align ||
      this.stride * type.count !== type.size
    ) {
      throw new Error("Array ABI layout has an invalid size or alignment");
    }
    assertQpiSourceSize(source, type.size, "Array");
  }

  async get(index: number): Promise<unknown> {
    this.assertIndex(index);
    return await decodeSourceValue(
      this.source,
      index * this.stride,
      this.type.element,
    );
  }

  async entries(): Promise<QpiArrayEntry[]> {
    const entries: QpiArrayEntry[] = [];
    if (!this.capacity) {
      return entries;
    }

    const elementsPerPage = Math.max(
      1,
      Math.floor(this.source.maxReadLength / this.stride),
    );
    for (let start = 0; start < this.capacity; start += elementsPerPage) {
      const count = Math.min(elementsPerPage, this.capacity - start);
      const bytes = await readQpiBytes(
        this.source,
        start * this.stride,
        count * this.stride,
      );
      for (let pageIndex = 0; pageIndex < count; pageIndex++) {
        const index = start + pageIndex;
        const offset = pageIndex * this.stride;
        const encoded = bytes.subarray(offset, offset + this.stride);
        entries.push({
          index,
          value: await decodeSourceValue(
            qpiBorrowedSource(encoded),
            0,
            this.type.element,
          ),
          isZeroBytes: encoded.every((byte) => byte === 0),
        });
      }
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
        `Array index ${index} is outside 0..${this.capacity - 1}`,
      );
    }
  }
}
