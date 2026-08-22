import { AstKind } from "../../../shared/enums";
import { SCALAR_SIZE } from "../../../shared/scalar-sizes";
import { isSignedScalarType } from "../memory/memory-operations";
import type { Expression, TypeSpec } from "../../../ast";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";

// Standard conversion sequences, best first, and the user-defined one that ranks below all of them.
export const CONVERSION_RANK = {
    exact: 0,
    promotion: 1,
    conversion: 2,
    userDefined: 3,
    none: 4,
} as const;

/** The type C++ gives an integer literal: `u` makes it unsigned, `l`/`ll` or a value too wide makes it 64-bit. */
export function integerLiteralType(expression: Expression): TypeSpec | null {
    if (expression.kind !== AstKind.INT_LITERAL) {
        return null;
    }

    const suffix = (expression.suffix ?? "").toLowerCase();
    const unsigned = suffix.includes("u");
    const value = literalValue(expression.value);
    const widerThanInt = value === null || value > (unsigned ? 0xffffffffn : 0x7fffffffn);
    const wide = suffix.includes("l") || widerThanInt;

    return {
        kind: AstKind.NAME,
        name: unsigned ? (wide ? "unsigned long long" : "unsigned int") : wide ? "signed long long" : "signed int",
    };
}

function literalValue(text: string): bigint | null {
    try {
        return BigInt(text.replace(/'/g, ""));
    } catch {
        return null;
    }
}

function scalarWidth(programAnalysis: ProgramAnalysis, type: TypeSpec): number | null {
    const storage = programAnalysis.scalarStorageType(programAnalysis.derefType(type));

    if (storage.kind !== AstKind.NAME) {
        return null;
    }

    const base = storage.name.includes("::") ? storage.name.slice(storage.name.lastIndexOf("::") + 2) : storage.name;

    return SCALAR_SIZE[storage.name] ?? SCALAR_SIZE[base] ?? null;
}

/**
 * How well an argument type binds to a parameter type, by the ranking C++ uses to pick an overload.
 *
 * Expressed in width and signedness rather than type names, so it holds for any scalar spelling.
 */
export function conversionRank(programAnalysis: ProgramAnalysis, from: TypeSpec, to: TypeSpec): number {
    const target = programAnalysis.derefType(to);

    // Reaching a class from a scalar needs a converting constructor, which ranks below every
    // standard conversion.
    if (programAnalysis.isAggregateType(target)) {
        return CONVERSION_RANK.userDefined;
    }

    const fromWidth = scalarWidth(programAnalysis, from);
    const toWidth = scalarWidth(programAnalysis, target);

    if (fromWidth === null || toWidth === null) {
        return CONVERSION_RANK.none;
    }

    const fromSigned = isSignedScalarType(from, programAnalysis);
    const toSigned = isSignedScalarType(target, programAnalysis);

    if (fromWidth === toWidth && fromSigned === toSigned) {
        return CONVERSION_RANK.exact;
    }

    // Integral promotion: anything narrower than int arrives as int.
    if (fromWidth < 4 && toWidth === 4 && toSigned) {
        return CONVERSION_RANK.promotion;
    }

    return CONVERSION_RANK.conversion;
}
