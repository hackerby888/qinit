import { array, defineStruct, u8, u64 } from "@qinit/core";

export const ORACLE_INTERFACE_INDEX = 3;
export const QUERY_FEE = 1_000n;

export const OracleQuery = defineStruct("EvmLogReadOracleQuery", {
    chainId: u64,
    txHash: array(u8, 32),
    logIndex: u64,
});
export type OracleQuery = InstanceType<typeof OracleQuery>;

// topics holds four 32-byte words; both it and data are zero-padded beyond their length field.
export const OracleReply = defineStruct("EvmLogReadOracleReply", {
    code: u64,
    address: array(u8, 32),
    topicCount: u64,
    topics: array(u8, 128),
    dataLen: u64,
    data: array(u8, 256),
});
export type OracleReply = InstanceType<typeof OracleReply>;

export function getQueryFee(_query: OracleQuery): bigint {
    return QUERY_FEE;
}
