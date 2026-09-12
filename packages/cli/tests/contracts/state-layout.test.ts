// A redeploy into a reused slot keeps the old state bytes, so a changed StateData that no runnable MIGRATE handler rewrites must be refused before anything is uploaded.
import { expect, test } from "bun:test";
import { AbiTypeKind, type ContractIdl } from "@qinit/proto/contract-idl";
import { stateCarryoverRejection } from "../../src/ops/deploy/state-layout";

// `oldStateSize` declares a MIGRATE handler whose OldStateData is that many bytes; omit it for none.
function idl(size: number, format: string, oldStateSize?: number): ContractIdl {
    const state = { kind: AbiTypeKind.STRUCT, name: "StateData", size, align: 8, format, fields: [] };
    const migration = oldStateSize === undefined ? undefined : { oldState: { ...state, name: "OldStateData", size: oldStateSize } };
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

test("a changed layout with a MIGRATE handler that fits the deployed state is the handler's job", () => {
    expect(stateCarryoverRejection("Box", idl(24, "uint64, uint64, uint64"), idl(32, "uint64, uint64, uint64, uint64", 24))).toBeNull();
});

// The runtime fires MIGRATE only when OldStateData is exactly the deployed state's size, so a handler
// declared against the wrong old layout never runs — and its presence alone used to satisfy this guard,
// which is the one case where the bytes are reinterpreted with every check passed.
test("a MIGRATE handler that cannot run is refused, naming the two sizes", () => {
    const rejection = stateCarryoverRejection("Box", idl(24, "uint64, uint64, uint64"), idl(32, "uint64, uint64, uint64, uint64", 16));

    expect(rejection).toContain("was 24 B");
    expect(rejection).toContain("OldStateData of 16 B, not the 24 B the node holds");
    expect(rejection).toContain("would be skipped");
    expect(rejection).toContain("--allow-state-carryover");
});
