import { roundUp } from "@qinit/core";
import { decodeOutput } from "../abi-fmt";
import { AbiTypeKind, type AbiHashSet } from "../contract-idl";
import { hashSetGeometry } from "../qpi-layout";
import {
  assertPositivePowerOfTwo,
  assertQpiSourceSize,
  consecutiveRanges,
  occupiedFlagSlots,
  populationNumber,
  readUint64,
} from "./common";
import { QpiContainerConsistencyError } from "./errors";
import { readQpiBytes, type QpiByteSource } from "./source";

export interface QpiHashSetEntry {
  slot: number;
  key: unknown;
}

export class QpiHashSetView {
  readonly kind = AbiTypeKind.HASH_SET;
  readonly capacity: number;

  private readonly geometry;

  constructor(
    readonly type: AbiHashSet,
    private readonly source: QpiByteSource,
  ) {
    this.capacity = type.capacity;
    assertPositivePowerOfTwo(type.capacity, "HashSet capacity");
    this.geometry = hashSetGeometry(type.key, type.capacity);
    const align = Math.max(type.key.align, 8);
    if (
      type.align !== align ||
      roundUp(this.geometry.populationOffset + 16, align) !== type.size
    ) {
      throw new Error("HashSet ABI layout has an invalid size or alignment");
    }
    assertQpiSourceSize(source, type.size, "HashSet");
  }

  async entries(): Promise<QpiHashSetEntry[]> {
    const population = populationNumber(
      await readUint64(this.source, this.geometry.populationOffset),
      this.capacity,
    );
    if (!population) {
      return [];
    }

    const flags = await readQpiBytes(
      this.source,
      this.geometry.flagsOffset,
      this.geometry.flagsBytes,
    );
    const slots = occupiedFlagSlots(flags, this.capacity);
    if (slots.length !== population) {
      throw new QpiContainerConsistencyError(
        `HashSet has ${slots.length} occupied slots but population ${population}`,
      );
    }

    const entries: QpiHashSetEntry[] = [];
    for (const range of consecutiveRanges(slots)) {
      const count = range.end - range.start + 1;
      const bytes = await readQpiBytes(
        this.source,
        range.start * this.geometry.recordStride,
        count * this.geometry.recordStride,
      );
      for (let index = 0; index < count; index++) {
        const slot = range.start + index;
        const offset = index * this.geometry.recordStride;
        entries.push({
          slot,
          key: await decodeOutput(
            bytes.slice(offset, offset + this.type.key.size),
            this.type.key,
          ),
        });
      }
    }
    return entries;
  }
}
