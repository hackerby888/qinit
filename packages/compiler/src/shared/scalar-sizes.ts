export const SCALAR_SIZE: Record<string, number> = {
    bool: 1,
    bit: 1,
    sint8: 1,
    uint8: 1,
    "signed char": 1,
    "unsigned char": 1,
    sint16: 2,
    uint16: 2,
    "signed short": 2,
    "unsigned short": 2,
    sint32: 4,
    uint32: 4,
    "signed int": 4,
    "unsigned int": 4,
    sint64: 8,
    uint64: 8,
    "signed long long": 8,
    "unsigned long long": 8,
    "long long": 8,
    uint128: 16,
    id: 32,
    m256i: 32,
    __m256i: 32,
    auto: 8, // `auto` locals in qpi.h bodies are integer counters (pointer cases carry a trailing *)
    char: 1,
    // Native C spellings. Widths are the wasm32-wasi ones a contract actually builds against, which is
    // ILP32 — `long` is 4 bytes here, not the 8 an x86 habit would assume.
    short: 2,
    "short int": 2,
    "signed short int": 2,
    "unsigned short int": 2,
    int: 4,
    signed: 4,
    unsigned: 4,
    long: 4,
    "long int": 4,
    "signed long": 4,
    "signed long int": 4,
    "unsigned long": 4,
    "unsigned long int": 4,
    size_t: 4,
    wchar_t: 4,
};

export const SIGNED_SCALARS = new Set([
    "sint8",
    "sint16",
    "sint32",
    "sint64",
    "signed char",
    "signed short",
    "signed int",
    "signed long long",
    "long long",
    "int",
    "short",
    // plain `char` and `wchar_t` are signed on wasm32-wasi, per static_assert against the SDK
    "char",
    "wchar_t",
    "signed",
    "short int",
    "signed short int",
    "long",
    "long int",
    "signed long",
    "signed long int",
]);

// Constant-fold mirror of the backend's narrowCastIr: same widths, same signedness, over bigints. The two
// must agree or a folded constant disagrees with the value the emitter produces for the same cast.
export function narrowConstant(value: bigint, typeName: string | undefined): bigint {
    if (!typeName) return value;
    const byteWidth = SCALAR_SIZE[typeName];
    if (byteWidth === undefined || byteWidth >= 8) return value;
    if (typeName === "bit" || typeName === "bool") return value === 0n ? 0n : 1n;
    const bits = byteWidth * 8;
    return SIGNED_SCALARS.has(typeName) ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}
