// Two projects with the same contractName meet on one node: the plan reuses the slot by name, and only the project's own qinit.idl.json says whether that slot is its own.
import { expect, test } from "bun:test";
import type { ContractIdlArtifact } from "@qinit/proto/contract-idl";
import { emptyContractIdlFile } from "../../src/contracts/idl-file";
import { foreignSlotRejection } from "../../src/ops/deploy/slot-owner";

function recorded(slot: number) {
    const file = emptyContractIdlFile();
    file.contracts[String(slot)] = { name: "Counter", codeHash: "ab" } as unknown as ContractIdlArtifact;
    return file;
}

test("a reused slot this project recorded is its own", () => {
    expect(foreignSlotRejection([{ name: "Counter", slot: 31 }], recorded(31), "qinit.idl.json")).toBeNull();
});

test("a reused slot without a local record is refused, naming the owner problem and both ways out", () => {
    const rejection = foreignSlotRejection([{ name: "Counter", slot: 31 }], emptyContractIdlFile(), "qinit.idl.json");

    expect(rejection).toContain("slot 31 already runs a 'Counter' this project never deployed (no entry in qinit.idl.json)");
    expect(rejection).toContain("rename contractName in qinit.json");
    expect(rejection).toContain("--slot 31");
});

test("a fresh slot has no owner to check", () => {
    expect(foreignSlotRejection([], emptyContractIdlFile(), "qinit.idl.json")).toBeNull();
});
