import * as Mock from "./mock";

interface OcLayout {
    readonly SIZE: number;
}

// an OC interface has no reply layout: the invocation is one-way, the contract only ever polls the status.
export interface OcInterfaceDefinition {
    readonly index: number;
    readonly name: string;
    readonly request: OcLayout;
    getInvocationFee(request: Uint8Array): bigint;
}

export const OC_INTERFACES = [
    {
        index: Mock.OC_INTERFACE_INDEX,
        name: "Mock",
        request: Mock.OcRequest,
        getInvocationFee(request: Uint8Array): bigint {
            return Mock.getInvocationFee(Mock.OcRequest.wrap(request));
        },
    },
] as const satisfies readonly OcInterfaceDefinition[];
