import type { PlatformCapability } from "../../../shared/platform-capabilities";
export type { PlatformCapability } from "../../../shared/platform-capabilities";
export type PlatformPrimitiveKind = "zero" | "lane-pack-64" | "lane-pack-8" | "memory-load" | "memory-store" | "lane-compare-64" | "mask-extract" | "test-zero" | "wasm-unary" | "multiply-high" | "chain-rdrand";
export type PrimitiveOperand = "value" | "address" | "output-destination";
export type PrimitiveResultChannel = "value" | "address" | "void";
export interface PlatformPrimitive {
    readonly name: string;
    readonly aliases: readonly string[];
    readonly operands: readonly PrimitiveOperand[];
    readonly result: PrimitiveResultChannel;
    readonly kind: PlatformPrimitiveKind;
    readonly signed?: boolean;
    readonly wasmOp?: "i64.clz" | "i64.ctz";
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
        result: "address",
        kind: "zero",
    }),
    primitive({
        name: "_mm256_set_epi64x",
        aliases: [],
        operands: ["value", "value", "value", "value"],
        result: "address",
        kind: "lane-pack-64",
    }),
    primitive({
        name: "_mm256_set_epi8",
        aliases: [],
        operands: Array(32).fill("value"),
        result: "address",
        kind: "lane-pack-8",
    }),
    primitive({
        name: "_mm256_loadu_si256",
        aliases: ["_mm256_lddqu_si256"],
        operands: ["address"],
        result: "address",
        kind: "memory-load",
    }),
    primitive({
        name: "_mm256_storeu_si256",
        aliases: [],
        operands: ["address", "address"],
        result: "void",
        kind: "memory-store",
    }),
    primitive({
        name: "_mm256_cmpeq_epi64",
        aliases: [],
        operands: ["address", "address"],
        result: "address",
        kind: "lane-compare-64",
    }),
    primitive({
        name: "_mm256_movemask_epi8",
        aliases: [],
        operands: ["address"],
        result: "value",
        kind: "mask-extract",
    }),
    primitive({
        name: "_mm256_testz_si256",
        aliases: [],
        operands: ["address", "address"],
        result: "value",
        kind: "test-zero",
    }),
    primitive({
        name: "_mul128",
        aliases: [],
        operands: ["value", "value", "output-destination"],
        result: "value",
        kind: "multiply-high",
        signed: true,
    }),
    primitive({
        name: "_umul128",
        aliases: [],
        operands: ["value", "value", "output-destination"],
        result: "value",
        kind: "multiply-high",
        signed: false,
    }),
    primitive({
        name: "_tzcnt_u64",
        aliases: ["_tzcnt64"],
        operands: ["value"],
        result: "value",
        kind: "wasm-unary",
        wasmOp: "i64.ctz",
    }),
    primitive({
        name: "_lzcnt_u64",
        aliases: ["__lzcnt64"],
        operands: ["value"],
        result: "value",
        kind: "wasm-unary",
        wasmOp: "i64.clz",
    }),
    primitive({
        name: "_rdrand16_step",
        aliases: [],
        operands: ["output-destination"],
        result: "value",
        kind: "chain-rdrand",
        width: 16,
        capabilities: ["chain-prng"],
    }),
    primitive({
        name: "_rdrand32_step",
        aliases: [],
        operands: ["output-destination"],
        result: "value",
        kind: "chain-rdrand",
        width: 32,
        capabilities: ["chain-prng"],
    }),
    primitive({
        name: "_rdrand64_step",
        aliases: [],
        operands: ["output-destination"],
        result: "value",
        kind: "chain-rdrand",
        width: 64,
        capabilities: ["chain-prng"],
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
