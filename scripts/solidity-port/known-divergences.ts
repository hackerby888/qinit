// The archetypes that still disagree with clang, and the finding each is waiting on.

// Empty, and that is the intended resting state: every archetype in the corpus now either matches clang or is refused by both backends. An entry belongs here
// only while a finding is open, and the gate deletes it the moment the rows go green — see --strict below.
export const KNOWN_DIVERGENCES: Record<string, string> = {};

export function isKnownDivergence(archetype: string): boolean {
    return Object.prototype.hasOwnProperty.call(KNOWN_DIVERGENCES, archetype);
}
