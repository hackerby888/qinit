// Decodes one debug trace entry into the strings the trace views render.
import { decodeOutput, decodeLog, type DecodedLog } from "@qinit/proto";
import type { ContractCheat } from "@qinit/proto/contract-idl";
import type { DebugCheat } from "@qinit/core";
import { extractIdl } from "@qinit/build";
import type { ContractIdl } from "@qinit/proto/contract-idl";
import { stateDiffLines, type StateDiffLine } from "./state-diff";
import { enumMap, formatStateValue, stateFieldsOf, type StateField } from "./state-format";
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

    let fields: StateField[] = [];
    let stateDiff: StateDiffLine[] = [];
    let logs: DecodedLog[] = [];
    let cheats: DecodedCheat[] = [];

    try {
        const idl =
            contractIdl ??
            (source
                ? extractIdl(source, name, {
                      slot: entry.index,
                      qpiHeader,
                  })
                : undefined);

        if (idl) {
            const registered = entry.kind === 0 ? idl.functions : idl.procedures;
            const metadata = registered.find((candidate) => candidate.inputType === entry.entry);

            if (metadata && entry.inHex) {
                const decoded = await decodeOutput(hexToBytes(entry.inHex), metadata.input);
                input = formatStateValue(decoded, metadata.input, false, true);
            }
            if (metadata && entry.outHex) {
                const decoded = await decodeOutput(hexToBytes(entry.outHex), metadata.output);
                output = formatStateValue(decoded, metadata.output, false, true);
            }

            fields = stateFieldsOf(idl);
            stateDiff = await stateDiffLines(fields, entry.stateDiff);
            const enumNames = enumMap(idl);

            if (entry.logs?.length) {
                logs = await Promise.all(entry.logs.map((log) => decodeLog(log.type, log.size, log.hex, idl.logs, enumNames)));
            }

            if (entry.cheats?.length) {
                cheats = await decodeCheats(entry.cheats, idl.cheats);
            }
        }
    } catch {
        // Raw trace bytes remain available when decoding fails.
    }

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

export interface DecodedCheat {
    line: number;
    text: string;
}

/**
 * Rebuilds one CC_PRINT line. Literal parts come straight from the IDL and carry no bytes; a value
 * part is decoded against the type recorded for that argument, and labelled with its source text
 * when no literal precedes it.
 */
async function decodeCheats(records: readonly DebugCheat[], sites: readonly ContractCheat[]): Promise<DecodedCheat[]> {
    const byLine = new Map<number, ContractCheat>(sites.map((site) => [site.line, site]));
    const grouped = new Map<number, DebugCheat[]>();

    for (const record of records) {
        const line = record.id >>> 8 || record.id;
        grouped.set(line, [...(grouped.get(line) ?? []), record]);
    }

    const decoded: DecodedCheat[] = [];

    for (const [line, group] of grouped) {
        const site = byLine.get(line);

        if (!site) {
            decoded.push({ line, text: group.map((record) => record.hex || String(record.value)).join(" ") });
            continue;
        }

        const pieces: string[] = [];

        for (const [index, part] of site.parts.entries()) {
            if (part.lit !== undefined) {
                pieces.push(part.lit);
                continue;
            }

            const record = group.find((candidate) => (candidate.part ?? 0) === index);

            if (!record) {
                continue;
            }

            const value = record.size && part.type ? formatStateValue(await decodeOutput(hexToBytes(record.hex), part.type), part.type, false, true) : String(record.value);
            const labelled = site.parts[index - 1]?.lit === undefined && part.expr ? `${part.expr}=${value}` : value;

            pieces.push(labelled);
        }

        decoded.push({ line, text: pieces.join(" ") });
    }

    return decoded;
}
