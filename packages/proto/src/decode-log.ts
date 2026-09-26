// Decode a contract LOG_* call. Qubic SCs cannot use strings, so logs are numeric structs ending at `sint8 _terminator`; the node records every preceding byte.
import { abiValueToJson, decodeAbi, structFieldOffsets } from "./abi";
import { LOG_SEVERITY as SEVERITY } from "./protocol";
import { AbiTypeKind, type AbiStruct, type ContractLog } from "./contract-idl";
import { hexToBytes } from "@qinit/core";

export interface DecodedLog {
    severity: string;
    type: number;
    size: number;
    name?: string;
    typeName?: string;
    fields?: Record<string, unknown>;
    // The log struct and its field values in declaration order, so a renderer holding both can name every nested field — `fields` carries only the top level.
    abi?: AbiStruct;
    values?: unknown[];
    // the structs left when size, severity and the _type word could not pick one; the log is then shown as hex under these names
    candidates?: string[];
    hex: string;
}

// offsetof(_terminator): end of the last field — internal padding included, tail padding excluded.
export function loggedSizeOf(type: string | AbiStruct): number {
    const fo = structFieldOffsets(type);
    if (!fo.length) return 0;
    const last = fo[fo.length - 1];
    return last.off + last.size;
}

// Match a log's full byte size (not the capped hex) against the catalog; `enums` resolves the `_type` discriminator to its enum name.
export async function decodeLog(type: number, size: number, hex: string, catalog: ContractLog[], enums?: Record<string, string>): Promise<DecodedLog> {
    const severity = SEVERITY[type] ?? `type${type}`;
    const base: DecodedLog = {
        severity,
        type,
        size,
        hex: "0x" + (hex.startsWith("0x") ? hex.slice(2) : hex),
    };
    let loggedBytes: Uint8Array;
    try {
        loggedBytes = hexToBytes(hex);
    } catch {
        return base; // not hex at all: nothing below can read it
    }
    // an entry that recorded its severities is ruled out by a header type it never logs under; one without stays a candidate
    const sized = catalog.filter((entry) => loggedSizeOf(entry.type) === size && (!entry.severities?.length || entry.severities.includes(type)));
    const hit = sized.length > 1 ? byTypeWord(sized, loggedBytes) : sized;
    if (hit.length > 1) {
        return { ...base, candidates: hit.map((entry) => entry.name) };
    }
    if (hit.length === 1) {
        try {
            if (loggedBytes.length < size) {
                throw new Error("log bytes are truncated");
            }
            const structBytes = new Uint8Array(hit[0].type.size);
            structBytes.set(loggedBytes.subarray(0, structBytes.length));
            const struct = hit[0].type;
            const decoded = await decodeAbi(structBytes, struct);
            // decodeAbi unwraps a one-field struct to its bare value, which may itself be an array.
            const vals = struct.fields.length === 1 ? [decoded] : (decoded as unknown[]);
            const fields = abiValueToJson(vals, struct) as Record<string, unknown>;
            const tv = fields["_type"];
            const typeName = enums && (typeof tv === "number" || typeof tv === "bigint") ? enums[String(tv)] : undefined;
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
    return base; // no size match, or decode threw -> hex + severity only
}

// Same-size structs are told apart by the `_type` word each declares; an entry with no recorded values stays a candidate rather than being guessed away.
function byTypeWord(candidates: ContractLog[], bytes: Uint8Array): ContractLog[] {
    return candidates.filter((entry) => {
        if (!entry.types?.length) return true;
        const field = entry.type.fields.find((candidate) => candidate.name === "_type");
        if (!field || field.type.kind !== AbiTypeKind.SCALAR || field.offset + field.size > bytes.length) return true;
        let word = 0n;
        for (let index = field.size - 1; index >= 0; index--) word = (word << 8n) | BigInt(bytes[field.offset + index]);
        return entry.types.some((value) => BigInt(value) === word);
    });
}
