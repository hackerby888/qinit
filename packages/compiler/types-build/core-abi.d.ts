// Declaration-build shim only: runtime bundling resolves @qinit/core's real values, and staying structural avoids pulling a sibling workspace under rootDir.
declare module "@qinit/core" {
    export type LhostValueType = "i32" | "i64";
    export interface LhostFunctionSignature {
        readonly params: readonly LhostValueType[];
        readonly results: readonly LhostValueType[];
    }
    export type LhostImportName = string;
    export const LHOST_ABI: Readonly<Record<string, LhostFunctionSignature>>;
    export const CHEAT_OP: Readonly<{
        print: number;
        deal: number;
        warpTick: number;
        warpEpoch: number;
        prank: number;
        unprank: number;
    }>;
    export const ASSET_ENUMERATION_RECORD: Readonly<{
        size: number;
        fields: Readonly<{
            owner: Readonly<{ offset: number; size: number }>;
            possessor: Readonly<{ offset: number; size: number }>;
            shares: Readonly<{ offset: number; size: number }>;
            ownershipManagingContract: Readonly<{ offset: number; size: number }>;
            possessionManagingContract: Readonly<{ offset: number; size: number }>;
        }>;
    }>;
}
