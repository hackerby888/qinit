import { roundUp } from "@qinit/core";
import { decodeOutput } from "../abi-fmt";
import { AbiTypeKind, type AbiCollection } from "../contract-idl";
import { collectionGeometry } from "../qpi-layout";
import {
  assertPositivePowerOfTwo,
  assertQpiSourceSize,
  consecutiveRanges,
  NULL_INDEX,
  occupiedFlagSlots,
  populationNumber,
  readUint64,
  sint64At,
} from "./common";
import { QpiContainerConsistencyError } from "./errors";
import { readQpiBytes, type QpiByteSource } from "./source";

export interface QpiCollectionEntry {
  povSlot: number;
  elementIndex: number;
  pov: unknown;
  priority: bigint;
  value: unknown;
}

interface CollectionPov {
  slot: number;
  value: unknown;
  population: number;
  head: bigint;
  tail: bigint;
  root: bigint;
}

interface CollectionElement {
  priority: bigint;
  povSlot: bigint;
  parent: bigint;
  left: bigint;
  right: bigint;
}

export class QpiCollectionView {
  readonly kind = AbiTypeKind.COLLECTION;
  readonly capacity: number;

  private readonly geometry;

  constructor(
    readonly type: AbiCollection,
    private readonly source: QpiByteSource,
  ) {
    this.capacity = type.capacity;
    assertPositivePowerOfTwo(type.capacity, "Collection capacity");
    this.geometry = collectionGeometry(type.value, type.capacity);
    const align = Math.max(type.value.align, 8);
    if (
      type.align !== align ||
      roundUp(this.geometry.populationOffset + 16, align) !== type.size
    ) {
      throw new Error("Collection ABI layout has an invalid size or alignment");
    }
    assertQpiSourceSize(source, type.size, "Collection");
  }

  async entries(): Promise<QpiCollectionEntry[]> {
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
    const povSlots = occupiedFlagSlots(flags, this.capacity);
    if (!povSlots.length || povSlots.length > population) {
      throw new QpiContainerConsistencyError(
        "Collection population does not match its active PoVs",
      );
    }

    const povs = await this.readPovs(povSlots, population);
    if (povs.reduce((sum, pov) => sum + pov.population, 0) !== population) {
      throw new QpiContainerConsistencyError(
        "Collection population does not match its PoV populations",
      );
    }

    const elementBytes = await readQpiBytes(
      this.source,
      this.geometry.elementsOffset,
      population * this.geometry.elementStride,
    );
    const elements = Array.from(
      { length: population },
      (_, index) => this.elementAt(elementBytes, index),
    );
    const activePovSlots = new Set(povSlots);
    for (let index = 0; index < elements.length; index++) {
      const povSlot = elements[index].povSlot;
      if (
        povSlot < 0n ||
        povSlot >= BigInt(this.capacity) ||
        !activePovSlots.has(Number(povSlot))
      ) {
        throw new QpiContainerConsistencyError(
          `Collection element ${index} has invalid PoV ${povSlot}`,
        );
      }
    }

    const entries: QpiCollectionEntry[] = [];
    const seen = new Set<number>();
    for (const pov of povs) {
      const orderedIndices = this.walkPov(pov, elements, seen, population);
      for (const elementIndex of orderedIndices) {
        const offset = elementIndex * this.geometry.elementStride;
        entries.push({
          povSlot: pov.slot,
          elementIndex,
          pov: pov.value,
          priority: elements[elementIndex].priority,
          value: await decodeOutput(
            elementBytes.slice(offset, offset + this.type.value.size),
            this.type.value,
          ),
        });
      }
    }

    if (seen.size !== population) {
      throw new QpiContainerConsistencyError(
        `Collection has ${seen.size} reachable elements, expected ${population}`,
      );
    }
    return entries;
  }

  private async readPovs(
    slots: number[],
    totalPopulation: number,
  ): Promise<CollectionPov[]> {
    const povs: CollectionPov[] = [];
    for (const range of consecutiveRanges(slots)) {
      const count = range.end - range.start + 1;
      const bytes = await readQpiBytes(
        this.source,
        this.geometry.povsOffset + range.start * this.geometry.povStride,
        count * this.geometry.povStride,
      );
      for (let index = 0; index < count; index++) {
        const offset = index * this.geometry.povStride;
        const population = populationNumber(
          uint64At(bytes, offset + 32),
          totalPopulation,
        );
        if (!population) {
          throw new QpiContainerConsistencyError(
            `Collection PoV ${range.start + index} is active but empty`,
          );
        }
        povs.push({
          slot: range.start + index,
          value: await decodeOutput(bytes.slice(offset, offset + 32), "id"),
          population,
          head: sint64At(bytes, offset + 40),
          tail: sint64At(bytes, offset + 48),
          root: sint64At(bytes, offset + 56),
        });
      }
    }
    return povs;
  }

  private elementAt(bytes: Uint8Array, index: number): CollectionElement {
    const offset =
      index * this.geometry.elementStride + this.geometry.priorityOffset;
    return {
      priority: sint64At(bytes, offset),
      povSlot: sint64At(bytes, offset + 8),
      parent: sint64At(bytes, offset + 16),
      left: sint64At(bytes, offset + 24),
      right: sint64At(bytes, offset + 32),
    };
  }

  private walkPov(
    pov: CollectionPov,
    elements: CollectionElement[],
    seen: Set<number>,
    population: number,
  ): number[] {
    const root = elementIndex(pov.root, population, "root");
    const head = elementIndex(pov.head, population, "head");
    const tail = elementIndex(pov.tail, population, "tail");
    const ordered: number[] = [];
    const stack: Array<{
      index: number;
      parent: bigint;
      emit: boolean;
    }> = [{ index: root, parent: NULL_INDEX, emit: false }];

    while (stack.length) {
      const frame = stack.pop()!;
      if (frame.emit) {
        ordered.push(frame.index);
        continue;
      }
      if (seen.has(frame.index)) {
        throw new QpiContainerConsistencyError(
          `Collection element ${frame.index} is repeated or cyclic`,
        );
      }
      const element = elements[frame.index];
      if (element.povSlot !== BigInt(pov.slot)) {
        throw new QpiContainerConsistencyError(
          `Collection element ${frame.index} belongs to PoV ${element.povSlot}, expected ${pov.slot}`,
        );
      }
      if (element.parent !== frame.parent) {
        throw new QpiContainerConsistencyError(
          `Collection element ${frame.index} has parent ${element.parent}, expected ${frame.parent}`,
        );
      }
      seen.add(frame.index);

      const right = optionalElementIndex(element.right, population, "right");
      if (right !== null) {
        stack.push({ index: right, parent: BigInt(frame.index), emit: false });
      }
      stack.push({ ...frame, emit: true });
      const left = optionalElementIndex(element.left, population, "left");
      if (left !== null) {
        stack.push({ index: left, parent: BigInt(frame.index), emit: false });
      }
    }

    if (ordered.length !== pov.population) {
      throw new QpiContainerConsistencyError(
        `Collection PoV ${pov.slot} has ${ordered.length} elements, expected ${pov.population}`,
      );
    }
    if (ordered[0] !== head || ordered[ordered.length - 1] !== tail) {
      throw new QpiContainerConsistencyError(
        `Collection PoV ${pov.slot} has an invalid head or tail`,
      );
    }
    return ordered;
  }
}

function uint64At(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new QpiContainerConsistencyError("uint64 exceeds container range");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    8,
  ).getBigUint64(0, true);
}

function elementIndex(value: bigint, population: number, label: string): number {
  if (value < 0n || value >= BigInt(population)) {
    throw new QpiContainerConsistencyError(
      `Collection has invalid ${label} element index ${value}`,
    );
  }
  return Number(value);
}

function optionalElementIndex(
  value: bigint,
  population: number,
  label: string,
): number | null {
  return value === NULL_INDEX ? null : elementIndex(value, population, label);
}
