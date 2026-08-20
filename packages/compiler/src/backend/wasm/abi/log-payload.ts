import { AstKind, LogPayloadDefect } from "../../../shared/enums";
import { SCALAR_SIZE } from "../../../shared/scalar-sizes";
import type { StructLayout } from "../../../semantics/types";
import type { TypeSpec } from "../../../ast";

// The host logs the payload bytes preceding _terminator, so a log struct must carry one past the
// contract index and type words. Core states the same rule in logging.h.
export const LOG_TERMINATOR_FIELD = "_terminator";
export const MIN_TERMINATOR_OFFSET_BYTES = 8;

// The host overwrites the payload's leading word with the contract index before the record is
// persisted, so a field spanning those bytes loses them. Core keeps a 4-byte word there under
// several spellings (_contractIndex, contractIndex, contractId), so the rule matches on width.
export const LOG_HEADER_WORD_BYTES = 4;
export const LOG_HEADER_WORD_HINT = "must open with a 4-byte word reserved for the contract index";

// The struct-shape half of the contract. A null layout is left to the caller, which knows whether
// that means a definite scalar or a type it simply could not resolve.
export function logPayloadDefect(layout: StructLayout): LogPayloadDefect | null {
    const terminator = layout.fields.get(LOG_TERMINATOR_FIELD);

    if (!terminator) {
        return LogPayloadDefect.MISSING_TERMINATOR;
    }

    if (terminator.offset < MIN_TERMINATOR_OFFSET_BYTES) {
        return LogPayloadDefect.TERMINATOR_TOO_EARLY;
    }

    if (!headerWordIsReserved(layout)) {
        return LogPayloadDefect.HEADER_WORD_NOT_RESERVED;
    }

    return null;
}

// Empty members also report offset 0, so only sized fields decide whether the leading word is
// a slot of its own rather than the front of a wider value.
function headerWordIsReserved(layout: StructLayout): boolean {
    let found = false;

    for (const field of layout.fields.values()) {
        if (field.offset !== 0 || field.size === 0) {
            continue;
        }

        if (field.size !== LOG_HEADER_WORD_BYTES) {
            return false;
        }

        found = true;
    }

    return found;
}

export function logPayloadMessage(callName: string, defect: LogPayloadDefect): string {
    switch (defect) {
        case LogPayloadDefect.NOT_A_STRUCT:
            return `${callName} payload must be a struct`;
        case LogPayloadDefect.MISSING_TERMINATOR:
            return `${callName} payload struct must contain ${LOG_TERMINATOR_FIELD}`;
        case LogPayloadDefect.TERMINATOR_TOO_EARLY:
            return `${callName} payload ${LOG_TERMINATOR_FIELD} offset must be at least ${MIN_TERMINATOR_OFFSET_BYTES} bytes`;
        case LogPayloadDefect.HEADER_WORD_NOT_RESERVED:
            return `${callName} payload ${LOG_HEADER_WORD_HINT}`;
    }
}

// layoutOfType yields null for scalars, arrays and unresolved names alike, so only a recognised
// scalar is certain enough to call a non-struct payload.
export function isKnownScalarType(type: TypeSpec): boolean {
    if (type.kind !== AstKind.NAME) {
        return false;
    }

    if (SCALAR_SIZE[type.name] !== undefined) {
        return true;
    }

    const separator = type.name.lastIndexOf("::");

    if (separator < 0) {
        return false;
    }

    return SCALAR_SIZE[type.name.slice(separator + 2)] !== undefined;
}
