import { roundUp } from "@qinit/core";
import { decodeOutput } from "../abi-fmt";
import { AbiTypeKind, type AbiHashMap } from "../contract-idl";
import { hashMapGeometry } from "../qpi-layout";
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

export interface QpiHashMapEntry {
  slot: number;
  key: unknown;
  value: unknown;
}

export class QpiHashMapView {
  readonly kind = AbiTypeKind.HASH_MAP;
  readonly capacity: number;

  private readonly geometry;

  constructor(
    readonly type: AbiHashMap,
    private readonly source: QpiByteSource,
  ) {
    this.capacity = type.capacity;
    assertPositivePowerOfTwo(type.capacity, "HashMap capacity");
    this.geometry = hashMapGeometry(type.key, type.value, type.capacity);
    const align = Math.max(type.key.align, type.value.align, 8);
    if (
      type.align !== align ||
      roundUp(this.geometry.populationOffset + 16, align) !== type.size
    ) {
      throw new Error("HashMap ABI layout has an invalid size or alignment");
    }
    assertQpiSourceSize(source, type.size, "HashMap");
  }

  async entries(): Promise<QpiHashMapEntry[]> {
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
        `HashMap has ${slots.length} occupied slots but population ${population}`,
      );
    }

    const entries: QpiHashMapEntry[] = [];
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
          value: await decodeOutput(
            bytes.slice(
              offset + this.geometry.valueOffset,
              offset + this.geometry.valueOffset + this.type.value.size,
            ),
            this.type.value,
          ),
        });
      }
    }
    return entries;
  }
}
