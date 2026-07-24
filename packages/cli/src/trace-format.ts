// Share state and trace decoding across debug, call --trace, and state commands.
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

export const hexToBytes = (h: string) => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const a = new Uint8Array(s.length >> 1);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16);
  return a;
};
export const jstr = (v: any) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

// Compact array formatter: run-length-group consecutive equal values ("0 ×100") and cap the number of shown
// items unless `full` (--all). Keeps short arrays/structs literal so e.g. Fees [0,0,0] reads normally.
const RUN_MIN = 6,
  MAX_ITEMS = 32;
export function fmtVal(v: any, full = false): string {
  if (Array.isArray(v)) {
    const g: { s: string; n: number }[] = [];
    for (const el of v) {
      const s = fmtVal(el, full);
      const last = g[g.length - 1];
      if (last && last.s === s) last.n++;
      else g.push({ s, n: 1 });
    }
    let parts = g.flatMap((x) => (x.n >= RUN_MIN ? [`${x.s} ×${x.n}`] : Array(x.n).fill(x.s)));
    let more = "";
    if (!full && parts.length > MAX_ITEMS) {
      more = `, … +${parts.length - MAX_ITEMS} more (--all)`;
      parts = parts.slice(0, MAX_ITEMS);
    }
    return `[${parts.join(", ")}${more}]`;
  }
  if (v && typeof v === "object") return jstr(v);
  if (typeof v === "string") return JSON.stringify(v);
  return typeof v === "bigint" ? v.toString() : String(v);
}
export const keyLabel = (k: unknown) => (typeof k === "string" ? k : jstr(k)); // full id/string (copy-pasteable); jstr for numeric keys

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

// The compiler owns StateData layout; consumers use its exact offsets and sizes.
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

export function labelOff(fields: StateField[], off: number): string {
  const f = fields.find((x) => off >= x.off && off < x.off + x.size);
  return f ? f.name + (off > f.off ? "+" + (off - f.off) : "") : "@" + off;
}

// Format a changed-byte run for the state diff. Integer fields -> decimal (the run is little-endian, e.g. "64" -> 100);
// everything else (id / m256i / raw bytes) stays hex so it's still copy-pasteable.
const isIntType = (t: string) => /^(uint|sint)(8|16|32|64)$/.test(t) || t === "bit";
export function fmtDiffVal(fields: StateField[], off: number, hex: string): string {
  const f = fields.find((x) => off >= x.off && off < x.off + x.size);
  const type =
    f?.abi?.kind === AbiTypeKind.SCALAR ? f.abi.scalar : f?.type;
  if (!f || !type || !isIntType(type) || !/^[0-9a-fA-F]+$/.test(hex)) return hex;
  let v = 0n;
  for (let i = 0; i + 1 < hex.length; i += 2)
    v |= BigInt(parseInt(hex.slice(i, i + 2), 16)) << BigInt((i / 2) * 8);
  return v.toString();
}

// log _type -> enum name map; log-named enums applied last so they win value collisions with unrelated enums.
export function enumMap(idl: Pick<ContractIdl, "enums">): Record<string, string> {
  const m: Record<string, string> = {};
  for (const en of idl.enums) if (!/log/i.test(en.name)) Object.assign(m, en.members);
  for (const en of idl.enums) if (/log/i.test(en.name)) Object.assign(m, en.members);
  return m;
}

// decode each container field's CURRENT contents via state-read (capped 256KB), to logical entries.
export async function decodeColumns(
  rpc: StateReader,
  idx: number,
  fields: StateField[],
  full = false,
): Promise<ColView[]> {
  const out: ColView[] = [];
  for (const f of fields) {
    if (!f.container) continue;
    try {
      const sr = await rpc.stateRead(idx, f.off, Math.min(f.size, 262144));
      const buf = hexToBytes(sr.hex);
      const c = f.container;
      const ents =
        c.kind === "hashmap"
          ? (await decodeHashMap(buf, c.key, c.value, c.capacity)).map(
              (x) => `${keyLabel(x.key)} = ${fmtVal(x.value, full)}`,
            )
          : c.kind === "collection"
            ? (await decodeCollection(buf, c.value, c.capacity)).map(
                (x) => `${keyLabel(x.pov)}: ${fmtVal(x.value, full)} (p${x.priority})`,
              )
            : (await decodeHashSet(buf, c.key, c.capacity)).map((x) =>
                keyLabel(x.key),
              );
      const cap = full ? Infinity : 10;
      out.push({
        name: f.name,
        entries:
          ents.length > cap
            ? ents.slice(0, cap).concat(`… +${ents.length - cap} more (--all)`)
            : ents,
      });
    } catch {}
  }
  return out;
}

export const sevColor = (s: string) =>
  s === "ERROR" ? "red" : s === "WARN" ? "yellow" : s === "INFO" ? "green" : undefined;
export const fmtLog = (l: DecodedLog) =>
  `${l.severity} ${l.name ? l.name + (l.typeName ? "·" + l.typeName : "") + " " + jstr(l.fields) : l.size + "B " + l.hex.slice(0, 34) + "…"}`;

export interface TraceView {
  inDecoded: string;
  outDecoded: string;
  caller: string;
  fields: StateField[];
  cols: ColView[];
  logs: DecodedLog[];
}

// Decode one debug-trace entry: input/output, caller identity, StateData field map (for the diff), container
// contents, and the contract LOG_* records. `source` = the contract .h (from the dyn-registry); none -> hex.
export async function describeTrace(
  e: DebugEntry,
  source: string | undefined,
  name: string,
  rpc: StateReader,
  qpiHeader?: string,
): Promise<TraceView> {
  let inS = e.inHex ? "0x" + e.inHex : "(none)";
  let outS = e.outHex ? "0x" + e.outHex : "(none)";
  let caller = "(none)";
  if (e.kind === 1 && !/^0+$/.test(e.invocator)) {
    try {
      caller = await bytesToIdentity(hexToBytes(e.invocator));
    } catch {
      caller = "0x" + e.invocator.slice(0, 16) + "…";
    }
  }
  let fields: StateField[] = [];
  let cols: ColView[] = [];
  let logs: DecodedLog[] = [];
  if (source) {
    try {
      const idl = extractIdl(source, name, {
        slot: e.index,
        qpiHeader,
      });
      const entries = e.kind === 0 ? idl.functions : idl.procedures;
      const entry = entries.find((candidate) => candidate.inputType === e.entry);
      if (entry && e.inHex) {
        inS = jstr(await decodeOutput(hexToBytes(e.inHex), entry.input));
      }
      if (entry && e.outHex) {
        outS = jstr(await decodeOutput(hexToBytes(e.outHex), entry.output));
      }
      fields = stateFieldsOf(idl);
      cols = await decodeColumns(rpc, e.index, fields);
      const em = enumMap(idl);
      if (e.logs?.length) {
        logs = await Promise.all(
          e.logs.map((log) =>
            decodeLog(log.type, log.size, log.hex, idl.logs, em),
          ),
        );
      }
    } catch {}
  }
  return { inDecoded: inS, outDecoded: outS, caller, fields, cols, logs };
}

// Decode a contract's FULL current state: scalar fields (decoded to values) + containers (logical entries).
export interface StateDump {
  fields: { name: string; value: string }[];
  cols: ColView[];
}
export async function readState(
  rpc: StateReader,
  idx: number,
  source: string,
  name: string,
  full = false,
  qpiHeader?: string,
): Promise<StateDump> {
  const idl = extractIdl(source, name, {
    slot: idx,
    qpiHeader,
  });
  const fields = stateFieldsOf(idl);
  const scalars: { name: string; value: string }[] = [];
  for (const f of fields) {
    if (f.bad) {
      scalars.push({ name: f.name, value: `(undecodable: ${f.type} — fields below not shown)` });
      continue;
    }
    if (f.container) continue; // containers shown via decodeColumns below
    const CAP = 262144; // the node's state-read window
    try {
      // a plain Array<T,N> field larger than the read window: decode only the elements that fit + "first K of N".
      if (f.abi?.kind === AbiTypeKind.ARRAY && f.size > CAP) {
        const n = f.abi.count;
        const element = f.abi.element;
        const stride = Math.max(1, roundUp(element.size, element.align));
        const buf = hexToBytes((await rpc.stateRead(idx, f.off, CAP)).hex);
        const k = Math.min(n, Math.floor(buf.length / stride));
        const partial = {
          ...f.abi,
          count: k,
          size: k * stride,
          format: `[${k};${element.format}]`,
        };
        const dv = await decodeOutput(buf, partial);
        scalars.push({ name: f.name, value: `${fmtVal(dv, full)}  (first ${k} of ${n})` });
        continue;
      }
      const dv = await decodeOutput(
        hexToBytes((await rpc.stateRead(idx, f.off, Math.min(f.size, CAP))).hex),
        f.abi ?? f.type,
      );
      scalars.push({
        name: f.name,
        value: typeof dv === "object" && dv !== null ? fmtVal(dv, full) : String(dv),
      }); // bare scalar unquoted; struct/array run-length-grouped
    } catch {
      scalars.push({ name: f.name, value: "(read failed)" });
    }
  }
  return { fields: scalars, cols: await decodeColumns(rpc, idx, fields, full) };
}
