import { LOG_SEVERITY } from "@qinit/proto";
import { LOG_AMBIGUITY_HINT, LOG_TYPE_FIELD } from "../abi/log-payload";

// one log struct as the reader will see it: a size, the header types it is logged under and the `_type` word it carries. null sets are unknown.
export interface LogCandidate {
    name: string;
    loggedSize: number;
    typeField: { offset: number; size: number } | null;
    types: ReadonlySet<bigint> | null;
    severities: ReadonlySet<number> | null;
    line: number;
}

export interface LogAmbiguity {
    message: string;
    line: number;
}

// the reader has only the bytes, so two structs of one logged size must differ in severity or in a constant `_type`; anything less is reported once per pair.
export function logAmbiguities(candidates: readonly LogCandidate[], untracedTypeWrite?: number): LogAmbiguity[] {
    const found: LogAmbiguity[] = [];

    for (let first = 0; first < candidates.length; first++) {
        for (let second = first + 1; second < candidates.length; second++) {
            const a = candidates[first];
            const b = candidates[second];

            if (a.loggedSize !== b.loggedSize) {
                continue;
            }

            const shared = sharedSeverities(a, b);

            if (shared && shared.length === 0) {
                continue;
            }

            const cause = indistinguishable(a, b, untracedTypeWrite);

            if (!cause) {
                continue;
            }

            const at = shared ? ` at ${shared.map((level) => LOG_SEVERITY[level] ?? `type${level}`).join("/")}` : "";
            found.push({
                message: `log structs ${a.name} and ${b.name} both log ${a.loggedSize} bytes${at} and ${LOG_AMBIGUITY_HINT}: ${cause.reason}; give each a distinct constant ${LOG_TYPE_FIELD}`,
                line: cause.line ?? a.line,
            });
        }
    }

    return found;
}

// null when either side's severities are unknown: a struct that could be logged anywhere is checked against everything
function sharedSeverities(a: LogCandidate, b: LogCandidate): number[] | null {
    if (!a.severities?.size || !b.severities?.size) {
        return null;
    }

    return [...a.severities].filter((level) => b.severities!.has(level));
}

// the untraced write is reported at its own line, since the message text is not remapped from preprocessed coordinates
function indistinguishable(a: LogCandidate, b: LogCandidate, untracedTypeWrite?: number): { reason: string; line?: number } | null {
    if (!a.typeField && !b.typeField) {
        return { reason: `neither has a ${LOG_TYPE_FIELD} field` };
    }

    for (const candidate of [a, b]) {
        if (!candidate.typeField) {
            return { reason: `${candidate.name} has no ${LOG_TYPE_FIELD} field` };
        }
    }

    if (a.typeField!.offset !== b.typeField!.offset || a.typeField!.size !== b.typeField!.size) {
        return { reason: `${LOG_TYPE_FIELD} sits at different offsets` };
    }

    if (untracedTypeWrite !== undefined) {
        return { reason: `the ${LOG_TYPE_FIELD} write on this line could not be traced`, line: untracedTypeWrite };
    }

    for (const candidate of [a, b]) {
        if (!candidate.types?.size) {
            return { reason: `no constant is written into ${candidate.name}.${LOG_TYPE_FIELD}` };
        }
    }

    const collision = [...a.types!].find((value) => b.types!.has(value));

    return collision === undefined ? null : { reason: `both write ${LOG_TYPE_FIELD} = ${collision}` };
}
