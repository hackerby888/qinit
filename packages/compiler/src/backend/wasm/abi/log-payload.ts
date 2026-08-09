import { AstKind, LogPayloadDefect } from "../../../shared/enums";
import { SCALAR_SIZE } from "../../../shared/scalar-sizes";
import type { StructLayout } from "../../../analysis/types";
import type { TypeSpec } from "../../../ast";

// The host logs the payload bytes preceding _terminator, so a log struct must carry one past the
// contract index and type words. Core states the same rule in logging.h.
export const LOG_TERMINATOR_FIELD = "_terminator";
export const MIN_TERMINATOR_OFFSET_BYTES = 8;

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

    return null;
}

export function logPayloadMessage(
    callName: string,
    defect: LogPayloadDefect,
): string {
    switch (defect) {
        case LogPayloadDefect.NOT_A_STRUCT:
            return `${callName} payload must be a struct`;
        case LogPayloadDefect.MISSING_TERMINATOR:
            return `${callName} payload struct must contain ${LOG_TERMINATOR_FIELD}`;
        case LogPayloadDefect.TERMINATOR_TOO_EARLY:
            return `${callName} payload ${LOG_TERMINATOR_FIELD} offset must be at least ${MIN_TERMINATOR_OFFSET_BYTES} bytes`;
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
