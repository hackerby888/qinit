import { decodeAbiValue } from "../abi-fmt";
import {
  AbiScalarKind,
  AbiTypeKind,
  type AbiCollection,
  type AbiScalar,
} from "../contract-idl";
import { collectionGeometry } from "../qpi-layout";
import {
  QpiContainerConsistencyError,
  QpiIncompleteReadError,
} from "./errors";
import {
  readQpiBytes,
  readUint64,
  sint64At,
  uint64At,
  type QpiByteSource,
} from "./source";

const NULL_INDEX = -1n;
const POV_TYPE: AbiScalar = {
  kind: AbiTypeKind.SCALAR,
  scalar: AbiScalarKind.ID,
  size: 32,
  align: 8,
  format: "id",
};

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
    assertCapacity(type.capacity);
    this.geometry = collectionGeometry(type.value, type.capacity);
    if (
      type.align !== this.geometry.align ||
      type.size !== this.geometry.size
    ) {
      throw new Error("Collection ABI layout has an invalid size or alignment");
    }
    assertSource(source, type.size);
  }

  async entries(): Promise<QpiCollectionEntry[]> {
    const population = populationOf(
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
    const povSlots = occupiedSlots(flags, this.capacity);
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
          value: await decodeAbiValue(
            elementBytes.slice(
              offset + this.geometry.elementValueOffset,
              offset + this.geometry.elementValueOffset + this.type.value.size,
            ),
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
    for (const range of occupiedRanges(slots)) {
      const count = range.end - range.start + 1;
      const bytes = await readQpiBytes(
        this.source,
        this.geometry.povsOffset + range.start * this.geometry.povStride,
        count * this.geometry.povStride,
      );
      for (let index = 0; index < count; index++) {
        const offset = index * this.geometry.povStride;
        const population = populationOf(
          uint64At(bytes, offset + this.geometry.povPopulationOffset),
          totalPopulation,
        );
        if (!population) {
          throw new QpiContainerConsistencyError(
            `Collection PoV ${range.start + index} is active but empty`,
          );
        }
        povs.push({
          slot: range.start + index,
          value: await decodeAbiValue(
            bytes.slice(
              offset + this.geometry.povValueOffset,
              offset + this.geometry.povValueOffset + POV_TYPE.size,
            ),
            POV_TYPE,
          ),
          population,
          head: sint64At(bytes, offset + this.geometry.povHeadOffset),
          tail: sint64At(bytes, offset + this.geometry.povTailOffset),
          root: sint64At(bytes, offset + this.geometry.povBstRootOffset),
        });
      }
    }
    return povs;
  }

  private elementAt(bytes: Uint8Array, index: number): CollectionElement {
    const offset = index * this.geometry.elementStride;
    return {
      priority: sint64At(bytes, offset + this.geometry.elementPriorityOffset),
      povSlot: sint64At(bytes, offset + this.geometry.elementPovIndexOffset),
      parent: sint64At(bytes, offset + this.geometry.elementBstParentOffset),
      left: sint64At(bytes, offset + this.geometry.elementBstLeftOffset),
      right: sint64At(bytes, offset + this.geometry.elementBstRightOffset),
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

function assertCapacity(capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error("Collection capacity must be a positive power of two");
  }
  const integer = BigInt(capacity);
  if ((integer & (integer - 1n)) !== 0n) {
    throw new Error("Collection capacity must be a positive power of two");
  }
}

function assertSource(source: QpiByteSource, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Collection ABI has an invalid size");
  }
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < size) {
    throw new QpiIncompleteReadError(
      `Collection needs ${size} bytes, source has ${source.byteLength}`,
    );
  }
  if (
    !Number.isSafeInteger(source.maxReadLength) ||
    source.maxReadLength <= 0
  ) {
    throw new Error("QPI byte source has an invalid maxReadLength");
  }
}

function populationOf(population: bigint, capacity: number): number {
  if (population > BigInt(capacity)) {
    throw new QpiContainerConsistencyError(
      `container population ${population} exceeds capacity ${capacity}`,
    );
  }
  return Number(population);
}

function occupiedSlots(flags: Uint8Array, capacity: number): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < capacity; slot++) {
    const wordOffset = Math.floor(slot / 32) * 8;
    const flag = Number(
      (uint64At(flags, wordOffset) >> BigInt((slot % 32) * 2)) & 3n,
    );
    if (flag === 1) {
      slots.push(slot);
    } else if (flag === 3) {
      throw new QpiContainerConsistencyError(
        `invalid occupation flag at slot ${slot}`,
      );
    }
  }
  return slots;
}

function occupiedRanges(
  slots: number[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const slot of slots) {
    const last = ranges[ranges.length - 1];
    if (last && slot === last.end + 1) {
      last.end = slot;
    } else {
      ranges.push({ start: slot, end: slot });
    }
  }
  return ranges;
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
