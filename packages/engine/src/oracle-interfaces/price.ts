import { blob, defineStruct, i64, u64 } from "@qinit/core";

export const ORACLE_INTERFACE_INDEX = 0;
export const QUERY_FEE = 10n;

export const OracleQuery = defineStruct("PriceOracleQuery", {
  oracle: blob(32),
  timestamp: u64,
  currency1: blob(32),
  currency2: blob(32),
});
export type OracleQuery = InstanceType<typeof OracleQuery>;

export const OracleReply = defineStruct("PriceOracleReply", {
  numerator: i64,
  denominator: i64,
});
export type OracleReply = InstanceType<typeof OracleReply>;

export function getQueryFee(_query: OracleQuery): bigint {
  return QUERY_FEE;
}
