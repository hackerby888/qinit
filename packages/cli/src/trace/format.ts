import {
  decodeOutput,
  decodeHashMap,
  decodeHashSet,
  decodeCollection,
  decodeLog,
  collectionGeometry,
  hashMapGeometry,
  hashSetGeometry,
  occupationFlagAt,
  type DecodedLog,
} from "@qinit/proto";
import {
  AbiTypeKind,
  type AbiType,
  type ContractIdl,
} from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import {
  bytesToIdentity,
  hexToBytes,
  roundUp,
  type DebugEntry,
} from "@qinit/core";

export { hexToBytes };

export type StateContainerLayout =
  | {
      kind: "hashmap";
      key: AbiType;
      value: AbiType;
      capacity: number;
    }
  | {
      kind: "hashset";
      key: AbiType;
      capacity: number;
    }
  | {
      kind: "collection";
      value: AbiType;
      capacity: number;
    };
export type StateField = {
  name: string;
  off: number;
  size: number;
  type: string;
  abi?: AbiType;
  container?: StateContainerLayout;
  bad?: boolean;
};
export type DecodedStateContainer = {
  name: string;
  entries: string[];
  kind?: StateContainerLayout["kind"];
  capacity?: number;
  occupiedSlots?: number;
  totalEntries?: number;
  error?: string;
};
export type StateReader = {
  stateRead(slot: number, off: number, len: number): Promise<{ hex: string }>;
};
export type StateReadProgress = (
  field: string,
  completedBytes: number,
  totalBytes: number,
) => void;

export const jstr = (value: any) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
  );

const RUN_MIN = 6;
const MAX_ITEMS = 32;
const MAX_STATE_READ = 262144;

export function fmtVal(value: any, full = false): string {
  if (Array.isArray(value)) {
    const groups: { value: string; count: number }[] = [];

    for (const element of value) {
      const formatted = fmtVal(element, full);
      const last = groups[groups.length - 1];
      if (last && last.value === formatted) {
        last.count++;
      } else {
        groups.push({ value: formatted, count: 1 });
      }
    }

    let parts = groups.flatMap((group) =>
      group.count >= RUN_MIN
        ? [`${group.value} ×${group.count}`]
        : Array(group.count).fill(group.value),
    );
    let suffix = "";

    if (!full && parts.length > MAX_ITEMS) {
      suffix = `, … +${parts.length - MAX_ITEMS} more (--all)`;
      parts = parts.slice(0, MAX_ITEMS);
    }

    return `[${parts.join(", ")}${suffix}]`;
  }
  if (value && typeof value === "object") {
    return jstr(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return typeof value === "bigint" ? value.toString() : String(value);
}

export const keyLabel = (key: unknown) =>
  typeof key === "string" ? key : jstr(key);

function stateReadError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

async function readStateBytes(
  rpc: StateReader,
  contractIndex: number,
  offset: number,
  length: number,
  onChunk?: (completedBytes: number) => void,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw new Error("invalid state byte range");
  }

  const bytes = new Uint8Array(length);
  let completed = 0;

  while (completed < length) {
    const chunkLength = Math.min(MAX_STATE_READ, length - completed);
    const { hex } = await rpc.stateRead(
      contractIndex,
      offset + completed,
      chunkLength,
    );

    if (
      hex.length !== chunkLength * 2 ||
      !/^[0-9a-f]*$/i.test(hex)
    ) {
      throw new Error(
        `short state read at ${offset + completed}: expected ${chunkLength} bytes, got ${Math.floor(hex.length / 2)}`,
      );
    }

    bytes.set(hexToBytes(hex), completed);
    completed += chunkLength;
    onChunk?.(completed);
  }

  return bytes;
}

function uint64At(bytes: Uint8Array, offset = 0): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new Error("uint64 exceeds state range");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    8,
  ).getBigUint64(0, true);
}

function sint64At(bytes: Uint8Array, offset: number): bigint {
  if (offset < 0 || offset + 8 > bytes.length) {
    throw new Error("sint64 exceeds state range");
  }
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    8,
  ).getBigInt64(0, true);
}

function populationOf(bytes: Uint8Array, capacity: number): number {
  const population = uint64At(bytes);
  if (population > BigInt(capacity)) {
    throw new Error(
      `container population ${population} exceeds capacity ${capacity}`,
    );
  }
  return Number(population);
}

function assertContainerRange(
  field: StateField,
  relativeOffset: number,
  length: number,
): void {
  if (
    !Number.isSafeInteger(relativeOffset) ||
    !Number.isSafeInteger(length) ||
    relativeOffset < 0 ||
    length < 0 ||
    relativeOffset + length > field.size
  ) {
    throw new Error(`invalid ${field.name} container layout`);
  }
}

function occupiedSlots(
  flags: Uint8Array,
  capacity: number,
): number[] {
  const occupied: number[] = [];
  for (let slot = 0; slot < capacity; slot++) {
    const flag = occupationFlagAt(flags, slot);
    if (flag === 1) {
      occupied.push(slot);
    } else if (flag === 3) {
      throw new Error(`invalid occupation flag at slot ${slot}`);
    }
  }
  return occupied;
}

function consecutiveRanges(indices: number[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
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

function containerLines(
  capacity: number,
  entries: { slot: number; text: string }[],
  collection = false,
): string[] {
  const lines: string[] = [];
  const slots = [...new Set(entries.map((entry) => entry.slot))];
  let nextSlot = 0;
  let entryIndex = 0;

  const addGap = (start: number, end: number) => {
    if (end < start) {
      return;
    }
    const count = end - start + 1;
    const noun = collection ? "PoV slots" : "slots";
    const label = start === end
      ? `${noun.slice(0, -1)}[${start}]`
      : `${noun}[${start}..${end}]`;
    lines.push(`${label} (unoccupied ×${count}; skipped)`);
  };

  for (const slot of slots) {
    addGap(nextSlot, slot - 1);
    while (entries[entryIndex]?.slot === slot) {
      lines.push(
        `${collection ? "PoV" : "slot"}[${slot}] ${entries[entryIndex].text}`,
      );
      entryIndex++;
    }
    nextSlot = slot + 1;
  }
  addGap(nextSlot, capacity - 1);
  return lines;
}

class ContainerChangedError extends Error {}

function containerLayoutOf(type: AbiType): StateContainerLayout | undefined {
  switch (type.kind) {
    case AbiTypeKind.HASH_MAP:
      return {
        kind: "hashmap",
        key: type.key,
        value: type.value,
        capacity: type.capacity,
      };
    case AbiTypeKind.HASH_SET:
      return {
        kind: "hashset",
        key: type.key,
        capacity: type.capacity,
      };
    case AbiTypeKind.COLLECTION:
      return {
        kind: "collection",
        value: type.value,
        capacity: type.capacity,
      };
    default:
      return undefined;
  }
}

export function stateFieldsOf(idl: Pick<ContractIdl, "state">): StateField[] {
  return idl.state.fields.map((field) => ({
    name: field.name,
    off: field.offset,
    size: field.size,
    type: field.type.format,
    abi: field.type,
    container: containerLayoutOf(field.type),
  }));
}

export function labelOff(fields: StateField[], offset: number): string {
  const field = fields.find(
    (candidate) =>
      offset >= candidate.off && offset < candidate.off + candidate.size,
  );
  return field
    ? field.name + (offset > field.off ? "+" + (offset - field.off) : "")
    : "@" + offset;
}

const isIntType = (type: string) =>
  /^(uint|sint)(8|16|32|64)$/.test(type) || type === "bit";

export function fmtDiffVal(
  fields: StateField[],
  offset: number,
  hex: string,
): string {
  const field = fields.find(
    (candidate) =>
      offset >= candidate.off && offset < candidate.off + candidate.size,
  );
  const type =
    field?.abi?.kind === AbiTypeKind.SCALAR ? field.abi.scalar : field?.type;
  if (
    !field ||
    !type ||
    !isIntType(type) ||
    !/^[0-9a-fA-F]+$/.test(hex)
  ) {
    return hex;
  }

  let value = 0n;
  for (let i = 0; i + 1 < hex.length; i += 2) {
    value |=
      BigInt(parseInt(hex.slice(i, i + 2), 16)) << BigInt((i / 2) * 8);
  }

  return value.toString();
}

export function enumMap(idl: Pick<ContractIdl, "enums">): Record<string, string> {
  const names: Record<string, string> = {};

  for (const item of idl.enums) {
    if (!/log/i.test(item.name)) {
      Object.assign(names, item.members);
    }
  }
  // Log enums win collisions with unrelated enum values.
  for (const item of idl.enums) {
    if (/log/i.test(item.name)) {
      Object.assign(names, item.members);
    }
  }

  return names;
}

export async function readStateContainers(
  rpc: StateReader,
  contractIndex: number,
  fields: StateField[],
  full = false,
): Promise<DecodedStateContainer[]> {
  const containers: DecodedStateContainer[] = [];

  for (const field of fields) {
    if (!field.container) {
      continue;
    }

    try {
      const state = await rpc.stateRead(
        contractIndex,
        field.off,
        Math.min(field.size, 262144),
      );
      const bytes = hexToBytes(state.hex);
      const container = field.container;
      const entries =
        container.kind === "hashmap"
          ? (
              await decodeHashMap(
                bytes,
                container.key,
                container.value,
                container.capacity,
              )
            ).map(
              (entry) =>
                `${keyLabel(entry.key)} = ${fmtVal(entry.value, full)}`,
            )
          : container.kind === "collection"
            ? (
                await decodeCollection(
                  bytes,
                  container.value,
                  container.capacity,
                )
              ).map(
                (entry) =>
                  `${keyLabel(entry.pov)}: ${fmtVal(entry.value, full)} (p${
                    entry.priority
                  })`,
              )
            : (
                await decodeHashSet(bytes, container.key, container.capacity)
              ).map((entry) =>
                keyLabel(entry.key),
              );

      const limit = full ? Infinity : 10;
      containers.push({
        name: field.name,
        entries:
          entries.length > limit
            ? entries
                .slice(0, limit)
                .concat(`… +${entries.length - limit} more (--all)`)
            : entries,
      });
    } catch {
      // An unreadable container should not hide the rest of the state.
    }
  }

  return containers;
}

async function readCompleteHashMap(
  rpc: StateReader,
  contractIndex: number,
  field: StateField,
  container: Extract<StateContainerLayout, { kind: "hashmap" }>,
): Promise<DecodedStateContainer> {
  const geometry = hashMapGeometry(
    container.key,
    container.value,
    container.capacity,
  );
  assertContainerRange(field, geometry.populationOffset, 8);
  assertContainerRange(field, geometry.flagsOffset, geometry.flagsBytes);

  const population = populationOf(
    await readStateBytes(
      rpc,
      contractIndex,
      field.off + geometry.populationOffset,
      8,
    ),
    container.capacity,
  );
  if (population === 0) {
    return {
      name: field.name,
      kind: container.kind,
      capacity: container.capacity,
      occupiedSlots: 0,
      totalEntries: 0,
      entries: containerLines(container.capacity, []),
    };
  }

  const flags = await readStateBytes(
    rpc,
    contractIndex,
    field.off + geometry.flagsOffset,
    geometry.flagsBytes,
  );
  const slots = occupiedSlots(flags, container.capacity);
  if (slots.length !== population) {
    throw new ContainerChangedError(
      `${field.name} population changed while reading`,
    );
  }

  const entries: { slot: number; text: string }[] = [];
  for (const range of consecutiveRanges(slots)) {
    const recordCount = range.end - range.start + 1;
    const rangeOffset = range.start * geometry.recordStride;
    const rangeLength = recordCount * geometry.recordStride;
    assertContainerRange(field, rangeOffset, rangeLength);
    const bytes = await readStateBytes(
      rpc,
      contractIndex,
      field.off + rangeOffset,
      rangeLength,
    );

    for (let index = 0; index < recordCount; index++) {
      const slot = range.start + index;
      const recordOffset = index * geometry.recordStride;
      const key = await decodeOutput(
        bytes.slice(recordOffset, recordOffset + container.key.size),
        container.key,
      );
      const value = await decodeOutput(
        bytes.slice(
          recordOffset + geometry.valueOffset,
          recordOffset + geometry.valueOffset + container.value.size,
        ),
        container.value,
      );
      entries.push({
        slot,
        text: `${keyLabel(key)} = ${fmtVal(value, true)}`,
      });
    }
  }

  return {
    name: field.name,
    kind: container.kind,
    capacity: container.capacity,
    occupiedSlots: slots.length,
    totalEntries: entries.length,
    entries: containerLines(container.capacity, entries),
  };
}

async function readCompleteHashSet(
  rpc: StateReader,
  contractIndex: number,
  field: StateField,
  container: Extract<StateContainerLayout, { kind: "hashset" }>,
): Promise<DecodedStateContainer> {
  const geometry = hashSetGeometry(container.key, container.capacity);
  assertContainerRange(field, geometry.populationOffset, 8);
  assertContainerRange(field, geometry.flagsOffset, geometry.flagsBytes);

  const population = populationOf(
    await readStateBytes(
      rpc,
      contractIndex,
      field.off + geometry.populationOffset,
      8,
    ),
    container.capacity,
  );
  if (population === 0) {
    return {
      name: field.name,
      kind: container.kind,
      capacity: container.capacity,
      occupiedSlots: 0,
      totalEntries: 0,
      entries: containerLines(container.capacity, []),
    };
  }

  const flags = await readStateBytes(
    rpc,
    contractIndex,
    field.off + geometry.flagsOffset,
    geometry.flagsBytes,
  );
  const slots = occupiedSlots(flags, container.capacity);
  if (slots.length !== population) {
    throw new ContainerChangedError(
      `${field.name} population changed while reading`,
    );
  }

  const entries: { slot: number; text: string }[] = [];
  for (const range of consecutiveRanges(slots)) {
    const recordCount = range.end - range.start + 1;
    const rangeOffset = range.start * geometry.recordStride;
    const rangeLength = recordCount * geometry.recordStride;
    assertContainerRange(field, rangeOffset, rangeLength);
    const bytes = await readStateBytes(
      rpc,
      contractIndex,
      field.off + rangeOffset,
      rangeLength,
    );

    for (let index = 0; index < recordCount; index++) {
      const recordOffset = index * geometry.recordStride;
      const key = await decodeOutput(
        bytes.slice(recordOffset, recordOffset + container.key.size),
        container.key,
      );
      entries.push({
        slot: range.start + index,
        text: keyLabel(key),
      });
    }
  }

  return {
    name: field.name,
    kind: container.kind,
    capacity: container.capacity,
    occupiedSlots: slots.length,
    totalEntries: entries.length,
    entries: containerLines(container.capacity, entries),
  };
}

type CollectionPov = {
  slot: number;
  id: unknown;
  population: number;
  root: bigint;
};

async function readCompleteCollection(
  rpc: StateReader,
  contractIndex: number,
  field: StateField,
  container: Extract<StateContainerLayout, { kind: "collection" }>,
): Promise<DecodedStateContainer> {
  const geometry = collectionGeometry(container.value, container.capacity);
  assertContainerRange(field, geometry.populationOffset, 8);
  assertContainerRange(field, geometry.flagsOffset, geometry.flagsBytes);

  const population = populationOf(
    await readStateBytes(
      rpc,
      contractIndex,
      field.off + geometry.populationOffset,
      8,
    ),
    container.capacity,
  );
  if (population === 0) {
    return {
      name: field.name,
      kind: container.kind,
      capacity: container.capacity,
      occupiedSlots: 0,
      totalEntries: 0,
      entries: containerLines(container.capacity, [], true),
    };
  }

  const flags = await readStateBytes(
    rpc,
    contractIndex,
    field.off + geometry.flagsOffset,
    geometry.flagsBytes,
  );
  const slots = occupiedSlots(flags, container.capacity);
  if (!slots.length || slots.length > population) {
    throw new ContainerChangedError(
      `${field.name} population changed while reading`,
    );
  }

  const povs: CollectionPov[] = [];
  for (const range of consecutiveRanges(slots)) {
    const recordCount = range.end - range.start + 1;
    const rangeOffset = range.start * geometry.povStride;
    const rangeLength = recordCount * geometry.povStride;
    assertContainerRange(field, rangeOffset, rangeLength);
    const bytes = await readStateBytes(
      rpc,
      contractIndex,
      field.off + rangeOffset,
      rangeLength,
    );

    for (let index = 0; index < recordCount; index++) {
      const recordOffset = index * geometry.povStride;
      const povPopulation = populationOf(
        bytes.slice(recordOffset + 32, recordOffset + 40),
        population,
      );
      if (povPopulation === 0) {
        throw new ContainerChangedError(
          `occupied PoV ${range.start + index} is empty`,
        );
      }
      povs.push({
        slot: range.start + index,
        id: await decodeOutput(
          bytes.slice(recordOffset, recordOffset + 32),
          "id",
        ),
        population: povPopulation,
        root: sint64At(bytes, recordOffset + 56),
      });
    }
  }

  if (povs.reduce((sum, pov) => sum + pov.population, 0) !== population) {
    throw new ContainerChangedError(
      `${field.name} population changed while reading`,
    );
  }

  const elementsLength = population * geometry.elementStride;
  assertContainerRange(field, geometry.elementsOffset, elementsLength);
  const elements = await readStateBytes(
    rpc,
    contractIndex,
    field.off + geometry.elementsOffset,
    elementsLength,
  );
  const povSlots = new Set(povs.map((pov) => pov.slot));
  const seen = new Set<number>();
  const entries: { slot: number; text: string }[] = [];

  const elementIndex = (value: bigint): number => {
    if (value < 0n || value >= BigInt(population)) {
      throw new ContainerChangedError(
        `invalid Collection element index ${value}`,
      );
    }
    return Number(value);
  };

  for (const pov of povs) {
    const stack: number[] = [];
    let current = pov.root;
    let count = 0;

    while (current !== -1n || stack.length) {
      while (current !== -1n) {
        const index = elementIndex(current);
        if (seen.has(index)) {
          throw new ContainerChangedError(
            `Collection element ${index} is repeated or cyclic`,
          );
        }
        const base = index * geometry.elementStride;
        const storedPov = sint64At(
          elements,
          base + geometry.priorityOffset + 8,
        );
        if (!povSlots.has(Number(storedPov)) || Number(storedPov) !== pov.slot) {
          throw new ContainerChangedError(
            `Collection element ${index} has invalid PoV`,
          );
        }
        seen.add(index);
        stack.push(index);
        current = sint64At(
          elements,
          base + geometry.priorityOffset + 3 * 8,
        );
      }

      const index = stack.pop()!;
      const base = index * geometry.elementStride;
      const value = await decodeOutput(
        elements.slice(base, base + container.value.size),
        container.value,
      );
      const priority = sint64At(elements, base + geometry.priorityOffset);
      entries.push({
        slot: pov.slot,
        text: `${keyLabel(pov.id)}: ${fmtVal(value, true)} (p${priority})`,
      });
      count++;
      current = sint64At(
        elements,
        base + geometry.priorityOffset + 4 * 8,
      );
    }

    if (count !== pov.population) {
      throw new ContainerChangedError(
        `PoV ${pov.slot} contains ${count} entries, expected ${pov.population}`,
      );
    }
  }

  if (seen.size !== population) {
    throw new ContainerChangedError(
      `Collection contains ${seen.size} reachable entries, expected ${population}`,
    );
  }

  return {
    name: field.name,
    kind: container.kind,
    capacity: container.capacity,
    occupiedSlots: slots.length,
    totalEntries: population,
    entries: containerLines(container.capacity, entries, true),
  };
}

async function readCompleteStateContainers(
  rpc: StateReader,
  contractIndex: number,
  fields: StateField[],
  onProgress?: StateReadProgress,
): Promise<DecodedStateContainer[]> {
  const containers: DecodedStateContainer[] = [];

  for (const field of fields) {
    const container = field.container;
    if (!container) {
      continue;
    }

    onProgress?.(field.name, 0, field.size);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const decoded =
          container.kind === "hashmap"
            ? await readCompleteHashMap(rpc, contractIndex, field, container)
            : container.kind === "hashset"
              ? await readCompleteHashSet(rpc, contractIndex, field, container)
              : await readCompleteCollection(rpc, contractIndex, field, container);
        containers.push(decoded);
        onProgress?.(field.name, field.size, field.size);
        break;
      } catch (error) {
        if (error instanceof ContainerChangedError && attempt === 0) {
          continue;
        }
        containers.push({
          name: field.name,
          kind: container.kind,
          capacity: container.capacity,
          occupiedSlots: 0,
          totalEntries: 0,
          entries: [],
          error: stateReadError(error),
        });
        onProgress?.(field.name, field.size, field.size);
        break;
      }
    }
  }

  return containers;
}

export const sevColor = (severity: string) =>
  severity === "ERROR"
    ? "red"
    : severity === "WARN"
      ? "yellow"
      : severity === "INFO"
        ? "green"
        : undefined;

export const fmtLog = (log: DecodedLog) => {
  const detail = log.name
    ? log.name +
      (log.typeName ? "·" + log.typeName : "") +
      " " +
      jstr(log.fields)
    : `${log.size}B ${log.hex.slice(0, 34)}…`;
  return `${log.severity} ${detail}`;
};

export interface DecodedTrace {
  inDecoded: string;
  outDecoded: string;
  caller: string;
  fields: StateField[];
  containers: DecodedStateContainer[];
  logs: DecodedLog[];
}

export async function describeTrace(
  entry: DebugEntry,
  source: string | undefined,
  name: string,
  rpc: StateReader,
  qpiHeader?: string,
): Promise<DecodedTrace> {
  let input = entry.inHex ? "0x" + entry.inHex : "(none)";
  let output = entry.outHex ? "0x" + entry.outHex : "(none)";
  let caller = "(none)";

  if (entry.kind === 1 && !/^0+$/.test(entry.invocator)) {
    try {
      caller = await bytesToIdentity(hexToBytes(entry.invocator));
    } catch {
      caller = "0x" + entry.invocator.slice(0, 16) + "…";
    }
  }

  let fields: StateField[] = [];
  let containers: DecodedStateContainer[] = [];
  let logs: DecodedLog[] = [];

  if (source) {
    try {
      const idl = extractIdl(source, name, {
        slot: entry.index,
        qpiHeader,
      });
      const registered = entry.kind === 0 ? idl.functions : idl.procedures;
      const metadata = registered.find(
        (candidate) => candidate.inputType === entry.entry,
      );

      if (metadata && entry.inHex) {
        input = jstr(
          await decodeOutput(hexToBytes(entry.inHex), metadata.input),
        );
      }
      if (metadata && entry.outHex) {
        output = jstr(
          await decodeOutput(hexToBytes(entry.outHex), metadata.output),
        );
      }

      fields = stateFieldsOf(idl);
      containers = await readStateContainers(rpc, entry.index, fields);
      const enumNames = enumMap(idl);

      if (entry.logs?.length) {
        logs = await Promise.all(
          entry.logs.map((log) =>
            decodeLog(log.type, log.size, log.hex, idl.logs, enumNames),
          ),
        );
      }
    } catch {
      // Raw trace bytes remain available when source decoding fails.
    }
  }

  return {
    inDecoded: input,
    outDecoded: output,
    caller,
    fields,
    containers,
    logs,
  };
}

export interface DecodedState {
  fields: { name: string; value: string }[];
  containers: DecodedStateContainer[];
  complete: boolean;
}

async function readSparseArray(
  rpc: StateReader,
  contractIndex: number,
  field: StateField,
  type: Extract<AbiType, { kind: AbiTypeKind.ARRAY }>,
  onProgress?: StateReadProgress,
): Promise<string> {
  if (!type.count) {
    return "[]";
  }

  const stride = Math.max(1, roundUp(type.element.size, type.element.align));
  if (
    !Number.isSafeInteger(stride) ||
    !Number.isSafeInteger(stride * type.count) ||
    stride * type.count > field.size
  ) {
    throw new Error(`invalid ${field.name} array layout`);
  }

  const elementsPerChunk = Math.max(1, Math.floor(MAX_STATE_READ / stride));
  const parts: string[] = [];
  let zeroStart: number | undefined;

  const flushZeros = (end: number) => {
    if (zeroStart === undefined) {
      return;
    }
    const count = end - zeroStart + 1;
    const range = zeroStart === end
      ? `[${zeroStart}]`
      : `[${zeroStart}..${end}]`;
    parts.push(
      `${range}=0${count > 1 ? ` ×${count}` : ""} (skipped)`,
    );
    zeroStart = undefined;
  };

  for (let start = 0; start < type.count; start += elementsPerChunk) {
    const count = Math.min(elementsPerChunk, type.count - start);
    const length = count * stride;
    const bytes = await readStateBytes(
      rpc,
      contractIndex,
      field.off + start * stride,
      length,
    );

    for (let localIndex = 0; localIndex < count; localIndex++) {
      const index = start + localIndex;
      const elementOffset = localIndex * stride;
      const encoded = bytes.subarray(elementOffset, elementOffset + stride);
      const zero = encoded.every((byte) => byte === 0);
      if (zero) {
        zeroStart ??= index;
        continue;
      }

      flushZeros(index - 1);
      const decoded = await decodeOutput(
        encoded.slice(0, type.element.size),
        type.element,
      );
      parts.push(`[${index}]=${fmtVal(decoded, true)}`);
    }

    onProgress?.(
      field.name,
      Math.min((start + count) * stride, field.size),
      field.size,
    );
  }

  flushZeros(type.count - 1);
  return parts.join(", ");
}

export async function readState(
  rpc: StateReader,
  contractIndex: number,
  source: string,
  name: string,
  qpiHeader?: string,
  onProgress?: StateReadProgress,
): Promise<DecodedState> {
  const idl = extractIdl(source, name, {
    slot: contractIndex,
    qpiHeader,
  });
  const fields = stateFieldsOf(idl);
  const decodedFields: { name: string; value: string }[] = [];

  for (const field of fields) {
    if (field.bad) {
      decodedFields.push({
        name: field.name,
        value: `(undecodable: ${field.type} — fields below not shown)`,
      });
      continue;
    }
    if (field.container) {
      continue;
    }

    try {
      onProgress?.(field.name, 0, field.size);
      if (field.abi?.kind === AbiTypeKind.ARRAY) {
        decodedFields.push({
          name: field.name,
          value: await readSparseArray(
            rpc,
            contractIndex,
            field,
            field.abi,
            onProgress,
          ),
        });
        continue;
      }

      const decoded = await decodeOutput(
        await readStateBytes(
          rpc,
          contractIndex,
          field.off,
          field.size,
          (completedBytes) =>
            onProgress?.(field.name, completedBytes, field.size),
        ),
        field.abi ?? field.type,
      );
      decodedFields.push({
        name: field.name,
        value:
          typeof decoded === "object" && decoded !== null
            ? fmtVal(decoded, true)
            : String(decoded),
      });
    } catch (error) {
      decodedFields.push({
        name: field.name,
        value: `(read failed: ${stateReadError(error)})`,
      });
    }
  }

  const containers = await readCompleteStateContainers(
    rpc,
    contractIndex,
    fields,
    onProgress,
  );

  return {
    fields: decodedFields,
    containers,
    complete:
      !decodedFields.some(
        (field) =>
          field.value.includes("read failed") ||
          field.value.includes("undecodable"),
      ) &&
      containers.every((container) => !container.error),
  };
}
