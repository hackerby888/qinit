// Shared shapes for fixture-driven suites: a bounded test, and the same declarations in both orders.
import { test } from "bun:test";

// Compiling one probe contract is bounded work; a fixture that hangs should name itself rather than stall the whole suite for the runner's timeout.
export const FIXTURE_TIMEOUT_MS = 30_000;

// A hook that compiles a contract runs for seconds; Bun's default budget is five, and a hook exceeding it takes its whole file down as one unnamed failure.
export const HEAVY_HOOK_TIMEOUT_MS = 120_000;

export function fixtureTest(name: string, body: () => Promise<void> | void): void {
    test(name, body, FIXTURE_TIMEOUT_MS);
}

export interface DeclarationOrder {
    order: string;
    members: string;
}

/** The same class members written both ways round: overload resolution must not depend on declaration order, so a multi-candidate fixture asserts both. */
export function bothDeclarationOrders(members: readonly string[]): DeclarationOrder[] {
    return [
        { order: "as declared", members: members.join("\n    ") },
        { order: "reversed", members: [...members].reverse().join("\n    ") },
    ];
}
