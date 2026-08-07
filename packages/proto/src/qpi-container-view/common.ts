import { decodeOutput } from "../abi-fmt";
import { AbiTypeKind, type AbiType } from "../contract-idl";
import { occupationFlagAt } from "../qpi-layout";
import {
  QpiContainerConsistencyError,
  QpiIncompleteReadError,
} from "./errors";
import { readQpiBytes, type QpiByteSource } from "./source";

export const NULL_INDEX = -1n;

export function assertPositivePowerOfTwo(
  value: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive power of two`);
  }
  const integer = BigInt(value);
  if ((integer & (integer - 1n)) !== 0n) {
    throw new Error(`${label} must be a positive power of two`);
  }
}

export function assertQpiSourceSize(
  source: QpiByteSource,
  size: number,
  label: string,
): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} ABI has an invalid size`);
  }
  if (
    !Number.isSafeInteger(source.byteLength) ||
    source.byteLength < size
  ) {
    throw new QpiIncompleteReadError(
      `${label} needs ${size} bytes, source has ${source.byteLength}`,
    );
  }
  if (
    !Number.isSafeInteger(source.maxReadLength) ||
    source.maxReadLength <= 0
  ) {
    throw new Error("QPI byte source has an invalid maxReadLength");
  }
}

export async function decodeSourceValue(
  source: QpiByteSource,
  offset: number,
  type: AbiType,
): Promise<unknown> {
  return await decodeOutput(
    await readQpiBytes(source, offset, type.size),
    type,
  );
}

export async function readUint64(
  source: QpiByteSource,
  offset: number,
): Promise<bigint> {
  const bytes = await readQpiBytes(source, offset, 8);
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(0, true);
}

export function sint64At(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new QpiContainerConsistencyError("sint64 exceeds container range");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    8,
  ).getBigInt64(0, true);
}

export function populationNumber(
  population: bigint,
  capacity: number,
): number {
  if (population > BigInt(capacity)) {
    throw new QpiContainerConsistencyError(
      `container population ${population} exceeds capacity ${capacity}`,
    );
  }
  return Number(population);
}

export function occupiedFlagSlots(
  flags: Uint8Array,
  capacity: number,
): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < capacity; slot++) {
    const flag = occupationFlagAt(flags, slot);
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

export function consecutiveRanges(
  indices: number[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && index === last.end + 1) {
      last.end = index;
    } else {
      ranges.push({ start: index, end: index });
    }
  }
  return ranges;
}

export type AbiContainerType = Extract<
  AbiType,
  {
    kind:
      | AbiTypeKind.ARRAY
      | AbiTypeKind.BIT_ARRAY
      | AbiTypeKind.HASH_MAP
      | AbiTypeKind.HASH_SET
      | AbiTypeKind.COLLECTION
      | AbiTypeKind.LINKED_LIST;
  }
>;
