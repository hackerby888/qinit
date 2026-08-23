// Shared shapes for fixture-driven suites: a bounded test, and the same declarations in both orders.
import { test } from "bun:test";

// Compiling one probe contract is bounded work. A fixture that hangs should name itself rather than
// stall the whole suite for the runner's timeout.
export const FIXTURE_TIMEOUT_MS = 30_000;

// A setup hook that compiles a contract, or builds one with Clang, runs for seconds rather than
// milliseconds. Bun's default hook budget is five seconds, and a hook that exceeds it takes its whole
// file's tests with it, reported as one unnamed failure that names none of them.
export const HEAVY_HOOK_TIMEOUT_MS = 120_000;

export function fixtureTest(name: string, body: () => Promise<void> | void): void {
    test(name, body, FIXTURE_TIMEOUT_MS);
}

export interface DeclarationOrder {
    order: string;
    members: string;
}

/**
 * The same class members written both ways round.
 *
 * Overload resolution must not depend on the order candidates are declared in, so a fixture with more
 * than one candidate asserts the same answer for both.
 */
export function bothDeclarationOrders(members: readonly string[]): DeclarationOrder[] {
    return [
        { order: "as declared", members: members.join("\n    ") },
        { order: "reversed", members: [...members].reverse().join("\n    ") },
    ];
}
