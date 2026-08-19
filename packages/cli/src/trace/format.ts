// Decodes one debug trace entry into the strings the trace views render.
import { decodeOutput, decodeLog, type DecodedLog } from "@qinit/proto";
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
    };
}
