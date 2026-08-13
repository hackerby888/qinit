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
        short: AbiScalarKind.SINT16,
        "signed short": AbiScalarKind.SINT16,
        "unsigned short": AbiScalarKind.UINT16,
        int: AbiScalarKind.SINT32,
        "signed int": AbiScalarKind.SINT32,
        "unsigned int": AbiScalarKind.UINT32,
        long: AbiScalarKind.SINT64,
        "unsigned long": AbiScalarKind.UINT64,
        "long long": AbiScalarKind.SINT64,
        "signed long long": AbiScalarKind.SINT64,
        "unsigned long long": AbiScalarKind.UINT64,
        size_t: AbiScalarKind.UINT64,
    };

    return scalars[normalized];
}
