// Decodes one debug trace entry into the strings the trace views render.
import { decodeOutput, decodeLog, type DecodedLog } from "@qinit/proto";
import { AbiTypeKind, type AbiType, type ContractCheat, type ContractIdl } from "@qinit/proto/contract-idl";
import type { DebugCheat } from "@qinit/core";
import { extractIdl } from "@qinit/build";
import { stateDiffLines, type StateDiffLine } from "./state-diff";
import { enumMap, formatStateValue, holdsContainer, scalarText, stateFieldsOf, type StateField } from "./state-format";
import { MIGRATE } from "./entry-label";
import { decodeValueBlocks, type ValueBlocks } from "./state-read";
import { bytesToIdentity, hexToBytes, type DebugEntry } from "@qinit/core";

export interface DecodedTrace {
    inDecoded: string;
    outDecoded: string;
    caller: string;
    fields: StateField[];
    stateDiff: StateDiffLine[];
    logs: DecodedLog[];
    cheats: DecodedCheat[];
}

/**
 * `contractIdl` is the IDL the build already produced for this slot. Prefer it: deriving one from source
 * alone loses what the build knew, notably a state field whose type a callee declares.
 */
export async function describeTrace(
    entry: DebugEntry,
    source: string | undefined,
    name: string,
    qpiHeader?: string,
    contractIdl?: ContractIdl,
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

    const idl = contractIdl ?? idlFromSource(source, name, entry.index, qpiHeader);

    let fields: StateField[] = [];
    let stateDiff: StateDiffLine[] = [];
    let logs: DecodedLog[] = [];

    // Every section decodes on its own, so a payload one section cannot read leaves the others intact.
    // Raw trace bytes remain available wherever decoding fails.
    if (idl) {
        // A caller may hold only part of an IDL — the browser IDE has the cheat table and little
        // else — so every section is optional rather than assumed present.
        const registered = (entry.kind === 0 ? idl.functions : idl.procedures) ?? [];
        const metadata = registered.find((candidate) => candidate.inputType === entry.entry);
        // A migration's input is the old state, which carries no entry number — its layout is OldStateData.
        const inputType = entry.kind === MIGRATE ? idl.migration?.oldState : metadata?.input;

        if (inputType && entry.inHex) {
            input = await orElse(input, async () => formatStateValue(await decodeOutput(hexToBytes(entry.inHex), inputType), inputType, false, true));
        }
        if (metadata && entry.outHex) {
            output = await orElse(output, async () =>
                formatStateValue(await decodeOutput(hexToBytes(entry.outHex), metadata.output), metadata.output, false, true),
            );
        }

        // The fields stand on their own: a diff that cannot be read must not make the state look absent.
        if (idl.state) {
            fields = await orElse(fields, async () => stateFieldsOf(idl));
            stateDiff = await orElse(stateDiff, () => stateDiffLines(fields, entry.stateDiff));
        }

        if (entry.logs?.length && idl.logs) {
            logs = await orElse(logs, () => Promise.all(entry.logs.map((log) => decodeLog(log.type, log.size, log.hex, idl.logs, enumMap(idl)))));
        }
    }

    // Prints are shown even without an IDL: the raw bytes still tell the dev the call was reached.
    const cheats = entry.cheats?.length ? await decodeCheats(entry.cheats, idl?.cheats ?? []) : [];

    return {
        inDecoded: input,
        outDecoded: output,
        caller,
        fields,
        stateDiff,
        logs,
        cheats,
    };
}

function idlFromSource(source: string | undefined, name: string, slot: number, qpiHeader: string | undefined): ContractIdl | undefined {
    if (!source) {
        return undefined;
    }

    try {
        return extractIdl(source, name, { slot, qpiHeader });
    } catch {
        return undefined;
    }
}

async function orElse<T>(fallback: T, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch {
        return fallback;
    }
}

export interface DecodedCheat {
    line: number;
    text: string;
    /** A container, or a struct holding one, as the blocks `qinit state` draws; `text` is then their head. */
    blocks?: ValueBlocks;
}

/**
 * Rebuilds one CC_PRINT line. Literal parts come straight from the IDL and carry no bytes; a value
 * part is decoded against the type recorded for that argument, and labelled with its source text
 * when no literal precedes it. A print of one value that holds a container becomes blocks instead,
 * since a whole state on one line reads as nothing at any width.
 */
async function decodeCheats(records: readonly DebugCheat[], sites: readonly ContractCheat[]): Promise<DecodedCheat[]> {
    // Both runtimes unpack the wire tag before it reaches the trace, so a record's id is already the line.
    const bySite = new Map<number, ContractCheat>(sites.map((site) => [site.id, site]));
    const decoded: DecodedCheat[] = [];

    for (const group of printInstances(records)) {
        decoded.push(await decodePrint(group, bySite.get(group[0].id)));
    }

    return decoded;
}

// The records of one print sit together in the trace, so a line's next print starts where a part
// ordinal repeats: a print in a loop keeps every iteration, whatever order a backend emits parts in.
function printInstances(records: readonly DebugCheat[]): DebugCheat[][] {
    const instances: DebugCheat[][] = [];
    let current: DebugCheat[] = [];

    for (const record of records) {
        if (current.length && (current[0].id !== record.id || current.some((seen) => seen.part === record.part))) {
            instances.push(current);
            current = [];
        }
        current.push(record);
    }

    return current.length ? [...instances, current] : instances;
}

async function decodePrint(group: DebugCheat[], site: ContractCheat | undefined): Promise<DecodedCheat> {
    if (!site) {
        return { line: group[0].id, text: group.map(rawCheatValue).join(" ") };
    }

    const pieces: string[] = [];
    const lone = site.parts.filter((part) => part.lit === undefined).length === 1;
    let blocks: ValueBlocks | undefined;

    for (const [index, part] of site.parts.entries()) {
        if (part.lit !== undefined) {
            pieces.push(part.lit);
            continue;
        }

        const record = group.find((candidate) => candidate.part === index);

        if (!record) {
            continue;
        }

        const unlabelled = site.parts[index - 1]?.lit === undefined && part.expr;
        blocks = lone && part.type ? await cheatBlocks(record, part.type) : undefined;

        if (blocks) {
            if (unlabelled) {
                pieces.push(unlabelled);
            }
            continue;
        }

        const value = part.type ? await cheatValue(record, part.type) : rawCheatValue(record);

        pieces.push(unlabelled ? `${part.expr}=${value}` : value);
    }

    return { line: site.line, text: pieces.join(" "), ...(blocks ? { blocks } : {}) };
}

// Undefined for anything that is not a container-bearing value at exactly its size; the inline path
// then decides between a decoded value and the raw bytes.
async function cheatBlocks(record: DebugCheat, type: AbiType): Promise<ValueBlocks | undefined> {
    if (record.size !== type.size || !holdsContainer(type)) {
        return undefined;
    }

    try {
        return await decodeValueBlocks(hexToBytes(record.hex), type);
    } catch {
        return undefined;
    }
}

// A value decodes only when the bytes are exactly its type's size. Anything else is shown raw with both
// sizes rather than dropped, so a stale IDL or a shape the compiler could not type still reads back.
// A print is the dev asking for the value, so nothing in it is elided.
async function cheatValue(record: DebugCheat, type: AbiType): Promise<string> {
    try {
        if (record.size === type.size) {
            return scalarText(await decodeOutput(hexToBytes(record.hex), type), type);
        }

        if (record.size === 0 && type.kind === AbiTypeKind.SCALAR && type.size <= 8) {
            return scalarText(await decodeOutput(registerBytes(record.value).subarray(0, type.size), type), type);
        }
    } catch {
        // Shown raw below.
    }

    if (record.size === 0) {
        return rawCheatValue(record);
    }

    return `${rawCheatValue(record)} (${record.size} bytes, ${record.size === type.size ? "undecodable" : `expected ${type.size}`})`;
}

// The register carries a wasm i64: the engine sends it signed, core-lite unsigned. Both name the same
// eight bytes, so the recorded type decides the sign rather than the runtime.
function registerBytes(value: number | string): Uint8Array {
    const bytes = new Uint8Array(8);

    new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true);

    return bytes;
}

function rawCheatValue(record: DebugCheat): string {
    return record.size ? "0x" + record.hex : String(record.value);
}
