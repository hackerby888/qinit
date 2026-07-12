// Declaration-build shim only. Runtime/browser bundling resolves @qinit/core's authoritative values;
// keeping this structural avoids pulling a sibling workspace's source tree under compile's rootDir.
declare module "@qinit/core" {
  export type LhostValueType = "i32" | "i64";
  export interface LhostFunctionSignature {
    readonly params: readonly LhostValueType[];
    readonly results: readonly LhostValueType[];
  }
  export type LhostImportName = string;
  export const LHOST_ABI: Readonly<Record<string, LhostFunctionSignature>>;
  export const ASSET_ENUMERATION_RECORD: Readonly<{
    size: number;
    capacity: number;
    fields: Readonly<{
      owner: Readonly<{ offset: number; size: number }>;
      possessor: Readonly<{ offset: number; size: number }>;
      shares: Readonly<{ offset: number; size: number }>;
      ownershipManagingContract: Readonly<{ offset: number; size: number }>;
      possessionManagingContract: Readonly<{ offset: number; size: number }>;
    }>;
  }>;
}
