import { defineStruct, u64 } from "@qinit/core";

export const ORACLE_INTERFACE_INDEX = 1;
export const QUERY_FEE = 10n;

export const OracleQuery = defineStruct("MockOracleQuery", {
    value: u64,
});
export type OracleQuery = InstanceType<typeof OracleQuery>;

export const OracleReply = defineStruct("MockOracleReply", {
    echoedValue: u64,
    doubledValue: u64,
});
export type OracleReply = InstanceType<typeof OracleReply>;

export function getQueryFee(_query: OracleQuery): bigint {
    return QUERY_FEE;
}
