import { array, defineStruct, u8, u64 } from "@qinit/core";

export const ORACLE_INTERFACE_INDEX = 4;
export const QUERY_FEE = 100n;

export const OracleQuery = defineStruct("QubicLogReadOracleQuery", {
    tick: u64,
    txHash: array(u8, 32),
    logId: u64,
});
export type OracleQuery = InstanceType<typeof OracleQuery>;

// for contract-emitted log types the body opens with core's 8-byte contractIndex/type prefix.
export const OracleReply = defineStruct("QubicLogReadOracleReply", {
    code: u64,
    contractIndex: u64,
    logType: u64,
    dataLen: u64,
    data: array(u8, 256),
});
export type OracleReply = InstanceType<typeof OracleReply>;

export function getQueryFee(_query: OracleQuery): bigint {
    return QUERY_FEE;
}
