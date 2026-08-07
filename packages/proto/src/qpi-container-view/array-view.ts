import { decodeAbiValue } from "../abi-fmt";
import { AbiTypeKind, type AbiArray } from "../contract-idl";
import { arrayGeometry } from "../qpi-layout";
import { QpiIncompleteReadError } from "./errors";
import { readQpiBytes, type QpiByteSource } from "./source";

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
    assertCapacity(type.count);
    const geometry = arrayGeometry(type.element, type.count);
    this.stride = geometry.stride;
    if (
      type.align !== geometry.align ||
      type.size !== geometry.size
    ) {
      throw new Error("Array ABI layout has an invalid size or alignment");
    }
    assertSource(source, type.size);
  }

  async get(index: number): Promise<unknown> {
    this.assertIndex(index);
    return await decodeAbiValue(
      await readQpiBytes(
        this.source,
        index * this.stride,
        this.type.element.size,
      ),
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
          value: await decodeAbiValue(
            encoded.slice(0, this.type.element.size),
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

function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new Error("Array capacity must be a non-negative integer");
  }
}

function assertSource(source: QpiByteSource, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Array ABI has an invalid size");
  }
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
    throw new QpiIncompleteReadError(
      `Array needs ${size} bytes, source has ${source.byteLength}`,
    );
  }
  if (
    !Number.isSafeInteger(source.maxReadLength) ||
    source.maxReadLength <= 0
  ) {
    throw new Error("QPI byte source has an invalid maxReadLength");
  }
}
