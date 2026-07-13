import { LITE_ABI_METADATA } from "./generated/lite-abi";

/** Browser-safe description of the dynamic-contract host ABI. */
export type LhostValueType = "i32" | "i64";

export interface LhostFunctionSignature {
  readonly params: readonly LhostValueType[];
  readonly results: readonly LhostValueType[];
}

const signature = (
  params: readonly LhostValueType[],
  results: readonly LhostValueType[],
): LhostFunctionSignature =>
  Object.freeze({
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
  });

type GeneratedImportName = (typeof LITE_ABI_METADATA.lhost)[number]["name"];

/** Exact names, order, and signatures generated from core-lite's canonical ABI rows. */
export const LHOST_ABI = Object.freeze(
  Object.fromEntries(
    LITE_ABI_METADATA.lhost.map((row) => [row.name, signature(row.params, row.results)]),
  ),
) as Readonly<Record<GeneratedImportName, LhostFunctionSignature>>;

export type LhostImportName = keyof typeof LHOST_ABI;

export const LITE_ABI_VERSION = LITE_ABI_METADATA.abiVersion;

export const SYSTEM_PROCEDURES = Object.freeze(
  Object.fromEntries(
    LITE_ABI_METADATA.systemProcedures.map((procedure) => [procedure.name, procedure.id]),
  ),
) as Readonly<Record<(typeof LITE_ABI_METADATA.systemProcedures)[number]["name"], number>>;

/** Contract-visible record written by lhost.assetEnumerate. */
const assetEntry = LITE_ABI_METADATA.records.LiteAssetEntry;
export const ASSET_ENUMERATION_RECORD = Object.freeze({
  size: assetEntry.size,
  capacity: assetEntry.capacity,
  fields: Object.freeze(
    Object.fromEntries(
      Object.entries(assetEntry.fields)
        .filter(([name]) => name !== "padding")
        .map(([name, field]) => [name, Object.freeze({ ...field })]),
    ),
  ) as Readonly<
    Record<
      Exclude<keyof typeof assetEntry.fields, "padding">,
      { readonly offset: number; readonly size: number }
    >
  >,
});
