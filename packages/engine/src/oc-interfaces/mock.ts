import { defineStruct, u64 } from "@qinit/core";

export const OC_INTERFACE_INDEX = 0;
export const INVOCATION_FEE = 10n;

export const OcRequest = defineStruct("MockOcRequest", {
    value: u64,
});
export type OcRequest = InstanceType<typeof OcRequest>;

export function getInvocationFee(_request: OcRequest): bigint {
    return INVOCATION_FEE;
}
