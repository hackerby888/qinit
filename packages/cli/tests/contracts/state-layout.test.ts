// A redeploy into a reused slot keeps the old state bytes, so a changed StateData without a MIGRATE handler must be refused before anything is uploaded.
import { expect, test } from "bun:test";
import { AbiTypeKind, type ContractIdl } from "@qinit/proto/contract-idl";
import { stateCarryoverRejection } from "../../src/ops/deploy/state-layout";

function idl(size: number, format: string, withMigration = false): ContractIdl {
    const state = { kind: AbiTypeKind.STRUCT, name: "StateData", size, align: 8, format, fields: [] };
    const migration = withMigration ? { oldState: state } : undefined;
    return { version: 1, name: "Box", slot: 30, functions: [], procedures: [], enums: [], logs: [], state, migration } as unknown as ContractIdl;
}

test("an unchanged layout redeploys", () => {
    expect(stateCarryoverRejection("Box", idl(24, "uint64, uint64, uint64"), idl(24, "uint64, uint64, uint64"))).toBeNull();
});

test("an inserted field without MIGRATE is refused, naming both layouts and the ways out", () => {
    const rejection = stateCarryoverRejection("Box", idl(24, "uint64, uint64, uint64"), idl(32, "uint64, uint32, uint64, uint64"));

    expect(rejection).toContain("was 24 B (uint64, uint64, uint64)");
    expect(rejection).toContain("now 32 B (uint64, uint32, uint64, uint64)");
    expect(rejection).toContain("Box has no MIGRATE handler");
    expect(rejection).toContain("--allow-state-carryover");
});

test("a same-size layout with different field types is still a change", () => {
    expect(stateCarryoverRejection("Box", idl(16, "uint64, uint64"), idl(16, "sint64, uint64"))).not.toBeNull();
});

test("a changed layout with a MIGRATE handler is the handler's job, not a refusal", () => {
    expect(stateCarryoverRejection("Box", idl(24, "uint64, uint64, uint64"), idl(32, "uint64, uint64, uint64, uint64", true))).toBeNull();
});
