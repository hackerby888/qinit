import { WASM_ABI_METADATA } from "./generated/wasm-abi";

/** Browser-safe description of the dynamic-contract host ABI. */
export type LhostValueType = "i32" | "i64";

export interface LhostFunctionSignature {
    readonly params: readonly LhostValueType[];
    readonly results: readonly LhostValueType[];
}

const signature = (params: readonly LhostValueType[], results: readonly LhostValueType[]): LhostFunctionSignature =>
    Object.freeze({
        params: Object.freeze([...params]),
        results: Object.freeze([...results]),
    });

type GeneratedImportName = (typeof WASM_ABI_METADATA.lhost)[number]["name"];

/** Exact names, order, and signatures generated from core-lite's canonical ABI rows. */
export const LHOST_ABI = Object.freeze(Object.fromEntries(WASM_ABI_METADATA.lhost.map((row) => [row.name, signature(row.params, row.results)]))) as Readonly<
    Record<GeneratedImportName, LhostFunctionSignature>
>;

export type LhostImportName = keyof typeof LHOST_ABI;

export const WASM_ABI_VERSION = WASM_ABI_METADATA.abiVersion;

export const SYSTEM_PROCEDURES = Object.freeze(
    Object.fromEntries(WASM_ABI_METADATA.systemProcedures.map((procedure) => [procedure.name, procedure.id])),
) as Readonly<Record<(typeof WASM_ABI_METADATA.systemProcedures)[number]["name"], number>>;

export const SYSTEM_PROCEDURE_COUNT = WASM_ABI_METADATA.systemProcedures.length;

/** Entry-point identifiers that follow the system-procedure range in core-lite. */
export const CONTRACT_ENTRY_POINTS = Object.freeze({
    userProcedure: SYSTEM_PROCEDURE_COUNT + 1,
    userFunction: SYSTEM_PROCEDURE_COUNT + 2,
    registerUserFunctionsAndProcedures: SYSTEM_PROCEDURE_COUNT + 3,
    userProcedureNotification: SYSTEM_PROCEDURE_COUNT + 4,
    migrateProcedure: SYSTEM_PROCEDURE_COUNT + 5,
});

/** Opcodes for the `cheat` import. Mirrors core-lite's `CHEAT_OP_*` in extensions/wasm/shared/abi_types.h. */
export const CHEAT_OP = Object.freeze({
    print: 1,
    deal: 2,
    warpTick: 3,
    warpEpoch: 4,
    prank: 5,
    unprank: 6,
});

/** Refusals from the `cheat` import. Negative so a caller can test one comparison, never a trap. */
export const CHEAT_ERR = Object.freeze({
    unknownOp: -1n,
    disabled: -2n,
    wrongContext: -3n,
});

/** The contract error code a Wasm trap surfaces under. Mirrors core-lite's `WASM_TRAP_ERROR_CODE`. */
export const WASM_TRAP_ERROR_CODE = 0xcc1d0000;

/** Contract-visible record written by lhost.assetEnumerate. */
const assetEntry = WASM_ABI_METADATA.records.AssetEntry;
export const ASSET_ENUMERATION_RECORD = Object.freeze({
    size: assetEntry.size,
    capacity: assetEntry.capacity,
    fields: Object.freeze(
        Object.fromEntries(
            Object.entries(assetEntry.fields)
                .filter(([name]) => name !== "padding")
                .map(([name, field]) => [name, Object.freeze({ ...field })]),
        ),
    ) as Readonly<Record<Exclude<keyof typeof assetEntry.fields, "padding">, { readonly offset: number; readonly size: number }>>,
});
