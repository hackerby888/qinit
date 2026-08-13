// Decode a contract LOG_* call. Qubic SCs cannot use strings (qpi forbids ""), so logs are NUMERIC STRUCTS.
// A log ends at its `sint8 _terminator`; the node records every preceding byte.
import { decodeOutput, structFieldOffsets } from "./abi-fmt";
import { LOG_SEVERITY as SEVERITY } from "./protocol";
import type { AbiStruct, ContractLog } from "./contract-idl";
import { hexToBytes } from "@qinit/core";

export interface DecodedLog {
    severity: string;
    type: number;
    size: number;
    name?: string;
    typeName?: string;
    fields?: Record<string, unknown>;
    // The log struct and its field values in declaration order, so a renderer holding both can name every
    // nested field — `fields` only carries the top level.
    abi?: AbiStruct;
    values?: unknown[];
    hex: string;
}

// offsetof(_terminator): end of the last field — internal padding included, tail padding excluded.
export function loggedSizeOf(fmt: string | AbiStruct): number {
    const fo = structFieldOffsets(fmt);
    if (!fo.length) return 0;
    const last = fo[fo.length - 1];
    return last.off + last.size;
}

// Match a log's full byte size (NOT the possibly-capped hex) against the catalog; a unique struct decodes.
// `enums` (value -> member name) resolves the `_type` discriminator field to its enum name (DecodedLog.typeName).
export async function decodeLog(
    type: number,
    size: number,
    hex: string,
    catalog: ContractLog[],
    enums?: Record<string, string>,
): Promise<DecodedLog> {
    const severity = SEVERITY[type] ?? `type${type}`;
    const base: DecodedLog = {
        severity,
        type,
        size,
        hex: "0x" + (hex.startsWith("0x") ? hex.slice(2) : hex),
    };
    const hit = catalog.filter((entry) => loggedSizeOf(entry.type) === size);
    if (hit.length === 1) {
        try {
            const loggedBytes = hexToBytes(hex);
            if (loggedBytes.length < size) {
                throw new Error("log bytes are truncated");
            }
            const structBytes = new Uint8Array(hit[0].type.size);
            structBytes.set(loggedBytes.subarray(0, structBytes.length));
            const struct = hit[0].type;
            const decoded = await decodeOutput(structBytes, struct);
            // decodeOutput unwraps a one-field struct to its bare value, which may itself be an array.
            const vals = struct.fields.length === 1 ? [decoded] : (decoded as unknown[]);
            const fields: Record<string, unknown> = {};
            struct.fields.forEach((field, index) => {
                fields[field.name] = vals[index];
            });
            const tv = fields["_type"];
            const typeName =
                enums && (typeof tv === "number" || typeof tv === "bigint")
                    ? enums[String(tv)]
                    : undefined;
            return {
                ...base,
                name: hit[0].name,
                ...(typeName ? { typeName } : {}),
                fields,
                abi: struct,
                values: vals,
            };
        } catch {}
    }
    return base; // 0 or >1 size matches, or decode threw -> hex + severity only
}
