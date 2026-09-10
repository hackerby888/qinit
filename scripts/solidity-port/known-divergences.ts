// The archetypes that still disagree with clang, and the finding each is waiting on.
//
// One list, read by both the sweep gate (check-sweep.ts) and the live-slice control in
// packages/compiler/tests/differential/solidity-port.test.ts, so the two cannot drift apart. Both read
// it in BOTH directions: a divergence from an archetype that is not listed is a regression, and a
// listed archetype whose rows all match is a stale entry to delete. A one-directional allowlist goes
// quietly green the moment a defect is fixed, which is the failure it exists to prevent.

export const KNOWN_DIVERGENCES: Record<string, string> = {
    K12OfComputedExpression: "F203 — template argument deduction discards a computed argument's type, so K12 hashes the wrong width",
    HostK12ExpressionVersusVariable: "F203 — the same deduction defect reached through the host intrinsic",
    DateAddMillisecCarryChain: "F221 — a mutable reference to a by-value parameter is never read back, so addMillisec drops the day carry",
};

export function isKnownDivergence(archetype: string): boolean {
    return Object.prototype.hasOwnProperty.call(KNOWN_DIVERGENCES, archetype);
}
