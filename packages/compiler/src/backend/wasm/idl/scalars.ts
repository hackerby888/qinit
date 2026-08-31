// C++ scalar names and byte widths mapped to the IDL's scalar kinds.
import { AbiScalarKind } from "@qinit/proto/contract-idl";

export function scalarKindForSize(size: number): AbiScalarKind {
    switch (size) {
        case 1:
            return AbiScalarKind.UINT8;
        case 2:
            return AbiScalarKind.UINT16;
        case 8:
            return AbiScalarKind.UINT64;
        case 16:
            return AbiScalarKind.UINT128;
        case 32:
            return AbiScalarKind.M256I;
        default:
            return AbiScalarKind.UINT32;
    }
}

export function scalarKindForName(name: string): AbiScalarKind | undefined {
    const normalized = name.replace(/^QPI::/, "");
    const scalars: Record<string, AbiScalarKind> = {
        bit: AbiScalarKind.BIT,
        id: AbiScalarKind.ID,
        m256i: AbiScalarKind.M256I,
        __m256i: AbiScalarKind.M256I,
        uint8: AbiScalarKind.UINT8,
        uint16: AbiScalarKind.UINT16,
        uint32: AbiScalarKind.UINT32,
        uint64: AbiScalarKind.UINT64,
        uint128: AbiScalarKind.UINT128,
        sint8: AbiScalarKind.SINT8,
        sint16: AbiScalarKind.SINT16,
        sint32: AbiScalarKind.SINT32,
        sint64: AbiScalarKind.SINT64,
        sint128: AbiScalarKind.SINT128,
        bool: AbiScalarKind.UINT8,
        char: AbiScalarKind.SINT8,
        "signed char": AbiScalarKind.SINT8,
        "unsigned char": AbiScalarKind.UINT8,
        // Native C spellings, one row per spelling SCALAR_SIZE knows. A spelling missing here falls back to
        // scalarKindForSize, which reports unsigned, so a signed field would silently lose its sign.
        short: AbiScalarKind.SINT16,
        "short int": AbiScalarKind.SINT16,
        "signed short": AbiScalarKind.SINT16,
        "signed short int": AbiScalarKind.SINT16,
        "unsigned short": AbiScalarKind.UINT16,
        "unsigned short int": AbiScalarKind.UINT16,
        int: AbiScalarKind.SINT32,
        signed: AbiScalarKind.SINT32,
        "signed int": AbiScalarKind.SINT32,
        unsigned: AbiScalarKind.UINT32,
        "unsigned int": AbiScalarKind.UINT32,
        // Contracts build for wasm32, which is ILP32: long and size_t are 4 bytes, matching SCALAR_SIZE.
        long: AbiScalarKind.SINT32,
        "long int": AbiScalarKind.SINT32,
        "signed long": AbiScalarKind.SINT32,
        "signed long int": AbiScalarKind.SINT32,
        "unsigned long": AbiScalarKind.UINT32,
        "unsigned long int": AbiScalarKind.UINT32,
        size_t: AbiScalarKind.UINT32,
        wchar_t: AbiScalarKind.SINT32, // __WCHAR_TYPE__ is int on wasm32
        "long long": AbiScalarKind.SINT64,
        "signed long long": AbiScalarKind.SINT64,
        "unsigned long long": AbiScalarKind.UINT64,
    };

    return scalars[normalized];
}
