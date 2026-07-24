import {
  decodeOutput,
  decodeHashMap,
  decodeHashSet,
  decodeCollection,
  decodeLog,
  type DecodedLog,
} from "@qinit/proto";
import {
  AbiTypeKind,
  type AbiType,
  type ContractIdl,
} from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { bytesToIdentity, roundUp, type DebugEntry } from "@qinit/core";

export type Container =
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
  container?: Container;
  bad?: boolean;
};
export type ColView = { name: string; entries: string[] };
export type StateReader = {
  stateRead(slot: number, off: number, len: number): Promise<{ hex: string }>;
};

export const hexToBytes = (input: string) => {
  const hex = input.startsWith("0x") ? input.slice(2) : input;
  const bytes = new Uint8Array(hex.length >> 1);

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
};

export const jstr = (value: any) =>
  JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
  );

const RUN_MIN = 6;
const MAX_ITEMS = 32;

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

function containerOf(type: AbiType): Container | undefined {
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
    container: containerOf(field.type),
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

export async function decodeColumns(
  rpc: StateReader,
  contractIndex: number,
  fields: StateField[],
  full = false,
): Promise<ColView[]> {
  const columns: ColView[] = [];

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
      columns.push({
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

  return columns;
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

export interface TraceView {
  inDecoded: string;
  outDecoded: string;
  caller: string;
  fields: StateField[];
  cols: ColView[];
  logs: DecodedLog[];
}

export async function describeTrace(
  entry: DebugEntry,
  source: string | undefined,
  name: string,
  rpc: StateReader,
  qpiHeader?: string,
): Promise<TraceView> {
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
  let cols: ColView[] = [];
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
      cols = await decodeColumns(rpc, entry.index, fields);
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
    cols,
    logs,
  };
}

export interface StateDump {
  fields: { name: string; value: string }[];
  cols: ColView[];
}
export async function readState(
  rpc: StateReader,
  contractIndex: number,
  source: string,
  name: string,
  full = false,
  qpiHeader?: string,
): Promise<StateDump> {
  const idl = extractIdl(source, name, {
    slot: contractIndex,
    qpiHeader,
  });
  const fields = stateFieldsOf(idl);
  const scalars: { name: string; value: string }[] = [];

  for (const field of fields) {
    if (field.bad) {
      scalars.push({
        name: field.name,
        value: `(undecodable: ${field.type} — fields below not shown)`,
      });
      continue;
    }
    if (field.container) {
      continue;
    }

    const MAX_READ = 262144;
    try {
      if (field.abi?.kind === AbiTypeKind.ARRAY && field.size > MAX_READ) {
        const total = field.abi.count;
        const element = field.abi.element;
        const stride = Math.max(1, roundUp(element.size, element.align));
        const bytes = hexToBytes(
          (await rpc.stateRead(contractIndex, field.off, MAX_READ)).hex,
        );
        const count = Math.min(total, Math.floor(bytes.length / stride));
        const partial = {
          ...field.abi,
          count,
          size: count * stride,
          format: `[${count};${element.format}]`,
        };
        const decoded = await decodeOutput(bytes, partial);
        scalars.push({
          name: field.name,
          value: `${fmtVal(decoded, full)}  (first ${count} of ${total})`,
        });
        continue;
      }

      const decoded = await decodeOutput(
        hexToBytes(
          (
            await rpc.stateRead(
              contractIndex,
              field.off,
              Math.min(field.size, MAX_READ),
            )
          ).hex,
        ),
        field.abi ?? field.type,
      );
      scalars.push({
        name: field.name,
        value:
          typeof decoded === "object" && decoded !== null
            ? fmtVal(decoded, full)
            : String(decoded),
      });
    } catch {
      scalars.push({ name: field.name, value: "(read failed)" });
    }
  }

  return {
    fields: scalars,
    cols: await decodeColumns(rpc, contractIndex, fields, full),
  };
}
