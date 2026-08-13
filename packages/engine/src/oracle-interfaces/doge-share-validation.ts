import { array, defineStruct, u8, u32, u64 } from "@qinit/core";
import { MAX_ORACLE_QUERY_SIZE } from "@qinit/proto";

export const ORACLE_INTERFACE_INDEX = 2;
export const QUERY_FEE = 1_000n;

const fixedQueryFields = {
    jobId: u64,
    solutionTime: array(u8, 4),
    solutionNonce: array(u8, 4),
    solutionExtraNonce2: array(u8, 8),
    target: array(u8, 32),
    taskPartialHeaderVersion: array(u8, 4),
    taskPartialHeaderDifficultyNBits: array(u8, 4),
    taskPartialHeaderPrevBlockHash: array(u8, 32),
    extraNonce1NumBytes: u32,
    coinbase1NumBytes: u32,
    coinbase2NumBytes: u32,
    numMerkleBranches: u32,
};

const FixedOracleQuery = defineStruct("DogeShareValidationFixedOracleQuery", fixedQueryFields);
const additionalDataSize = MAX_ORACLE_QUERY_SIZE - FixedOracleQuery.SIZE;

export const OracleQuery = defineStruct("DogeShareValidationOracleQuery", {
    ...fixedQueryFields,
    additionalData: array(u8, additionalDataSize),
});
export type OracleQuery = InstanceType<typeof OracleQuery>;

export const OracleReply = defineStruct("DogeShareValidationOracleReply", {
    compIndex: u32,
    isValid: u8,
});
export type OracleReply = InstanceType<typeof OracleReply>;

export function getQueryFee(_query: OracleQuery): bigint {
    return QUERY_FEE;
}
