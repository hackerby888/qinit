// The archetypes that still disagree with clang, and the finding each is waiting on.
//
// One list, read by both the sweep gate (check-sweep.ts) and the live-slice control in
// packages/compiler/tests/differential/solidity-port.test.ts, so the two cannot drift apart. Both read
// it in BOTH directions: a divergence from an archetype that is not listed is a regression, and a
// listed archetype whose rows all match is a stale entry to delete. A one-directional allowlist goes
// quietly green the moment a defect is fixed, which is the failure it exists to prevent.

// Empty, and that is the intended resting state: every archetype in the corpus now either matches clang
// or is refused by both backends. An entry belongs here only while a finding is open, and the gate
// deletes it the moment the rows go green — see --strict below.
export const KNOWN_DIVERGENCES: Record<string, string> = {};

export function isKnownDivergence(archetype: string): boolean {
    return Object.prototype.hasOwnProperty.call(KNOWN_DIVERGENCES, archetype);
}
