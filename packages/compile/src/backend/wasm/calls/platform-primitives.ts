import {
    PlatformCapability,
    PlatformPrimitiveKind,
    PlatformWasmOp,
    PrimitiveOperand,
    PrimitiveResultChannel,
} from "../../../enums";

export {
    PlatformCapability,
    PlatformPrimitiveKind,
    PlatformWasmOp,
    PrimitiveOperand,
    PrimitiveResultChannel,
};

export interface PlatformPrimitive {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly operands: readonly PrimitiveOperand[];
    readonly result: PrimitiveResultChannel;
    readonly kind: PlatformPrimitiveKind;
    readonly signed?: boolean;
    readonly wasmOp?: PlatformWasmOp;
    readonly width?: 16 | 32 | 64;
    readonly capabilities?: readonly PlatformCapability[];
}
const primitive = (descriptor: PlatformPrimitive): PlatformPrimitive => Object.freeze({
    ...descriptor,
    aliases: Object.freeze([...descriptor.aliases]),
    operands: Object.freeze([...descriptor.operands]),
    capabilities: descriptor.capabilities ? Object.freeze([...descriptor.capabilities]) : undefined,
});
export const PLATFORM_PRIMITIVES = Object.freeze([
    primitive({
        name: "_mm256_setzero_si256",
        aliases: [],
        operands: [],
        result: PrimitiveResultChannel.ADDRESS,
        kind: PlatformPrimitiveKind.ZERO,
    }),
    primitive({
        name: "_mm256_set_epi64x",
        aliases: [],
        operands: [PrimitiveOperand.VALUE, PrimitiveOperand.VALUE, PrimitiveOperand.VALUE, PrimitiveOperand.VALUE],
        result: PrimitiveResultChannel.ADDRESS,
        kind: PlatformPrimitiveKind.LANE_PACK_64,
    }),
    primitive({
        name: "_mm256_set_epi8",
        aliases: [],
        operands: Array(32).fill("value"),
        result: PrimitiveResultChannel.ADDRESS,
        kind: PlatformPrimitiveKind.LANE_PACK_8,
    }),
    primitive({
        name: "_mm256_loadu_si256",
        aliases: ["_mm256_lddqu_si256"],
        operands: [PrimitiveOperand.ADDRESS],
        result: PrimitiveResultChannel.ADDRESS,
        kind: PlatformPrimitiveKind.MEMORY_LOAD,
    }),
    primitive({
        name: "_mm256_storeu_si256",
        aliases: [],
        operands: [PrimitiveOperand.ADDRESS, PrimitiveOperand.ADDRESS],
        result: PrimitiveResultChannel.VOID,
        kind: PlatformPrimitiveKind.MEMORY_STORE,
    }),
    primitive({
        name: "_mm256_cmpeq_epi64",
        aliases: [],
        operands: [PrimitiveOperand.ADDRESS, PrimitiveOperand.ADDRESS],
        result: PrimitiveResultChannel.ADDRESS,
        kind: PlatformPrimitiveKind.LANE_COMPARE_64,
    }),
    primitive({
        name: "_mm256_movemask_epi8",
        aliases: [],
        operands: [PrimitiveOperand.ADDRESS],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.MASK_EXTRACT,
    }),
    primitive({
        name: "_mm256_testz_si256",
        aliases: [],
        operands: [PrimitiveOperand.ADDRESS, PrimitiveOperand.ADDRESS],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.TEST_ZERO,
    }),
    primitive({
        name: "_mul128",
        aliases: [],
        operands: [PrimitiveOperand.VALUE, PrimitiveOperand.VALUE, PrimitiveOperand.OUTPUT_DESTINATION],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.MULTIPLY_HIGH,
        signed: true,
    }),
    primitive({
        name: "_umul128",
        aliases: [],
        operands: [PrimitiveOperand.VALUE, PrimitiveOperand.VALUE, PrimitiveOperand.OUTPUT_DESTINATION],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.MULTIPLY_HIGH,
        signed: false,
    }),
    primitive({
        name: "_tzcnt_u64",
        aliases: ["_tzcnt64"],
        operands: [PrimitiveOperand.VALUE],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.WASM_UNARY,
        wasmOp: PlatformWasmOp.I64_CTZ,
    }),
    primitive({
        name: "_lzcnt_u64",
        aliases: ["__lzcnt64"],
        operands: [PrimitiveOperand.VALUE],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.WASM_UNARY,
        wasmOp: PlatformWasmOp.I64_CLZ,
    }),
    primitive({
        name: "_rdrand16_step",
        aliases: [],
        operands: [PrimitiveOperand.OUTPUT_DESTINATION],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.CHAIN_RDRAND,
        width: 16,
        capabilities: [PlatformCapability.CHAIN_PRNG],
    }),
    primitive({
        name: "_rdrand32_step",
        aliases: [],
        operands: [PrimitiveOperand.OUTPUT_DESTINATION],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.CHAIN_RDRAND,
        width: 32,
        capabilities: [PlatformCapability.CHAIN_PRNG],
    }),
    primitive({
        name: "_rdrand64_step",
        aliases: [],
        operands: [PrimitiveOperand.OUTPUT_DESTINATION],
        result: PrimitiveResultChannel.VALUE,
        kind: PlatformPrimitiveKind.CHAIN_RDRAND,
        width: 64,
        capabilities: [PlatformCapability.CHAIN_PRNG],
    }),
] satisfies readonly PlatformPrimitive[]);
const byAlias = new Map<string, PlatformPrimitive>();
for (const descriptor of PLATFORM_PRIMITIVES) {
    for (const spelling of [descriptor.name, ...descriptor.aliases]) {
        const previous = byAlias.get(spelling);
        if (previous)
            throw new Error(`duplicate platform primitive alias '${spelling}' (${previous.name}, ${descriptor.name})`);
        byAlias.set(spelling, descriptor);
    }
}
export function platformPrimitive(name: string): PlatformPrimitive | undefined {
    const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
    return byAlias.get(base);
}
