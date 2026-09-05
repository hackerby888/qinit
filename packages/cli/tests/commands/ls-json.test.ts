import { expect, test } from "bun:test";
import { lsJsonResult, lsTableRows, stateOf } from "../../src/commands/deploy-interact/ls";
import { contractLabel } from "../../src/ops/node";
import type { DynamicContractRegistryEntry } from "@qinit/core";

const entry = (over: Partial<DynamicContractRegistryEntry>): DynamicContractRegistryEntry => ({
    index: 29,
    armed: true,
    constructed: true,
    version: 1,
    name: "Counter",
    codeHash: "ab".repeat(32),
    functions: [],
    procedures: [],
    ...over,
});

test("a contract whose reserve is spent reads as dormant, and a node that reports no reserve stays ready", () => {
    expect(stateOf(entry({ feeReserve: "100000000000" }))).toBe("ready");
    expect(stateOf(entry({ feeReserve: "0" }))).toBe("dormant");
    expect(stateOf(entry({ feeReserve: "-12" }))).toBe("dormant");
    expect(stateOf(entry({}))).toBe("ready");
    expect(stateOf(entry({ constructed: false }))).toBe("constructing");
    expect(stateOf(entry({ armed: false, feeReserve: "0" }))).toBe("empty");
});

test("ls JSON carries the reserve beside the state", () => {
    const result = lsJsonResult([entry({ feeReserve: "0" }), entry({ index: 30, name: "Other" })], [], false);

    expect(result.deployed).toEqual([
        { slot: 29, name: "Counter", state: "dormant", version: 1, codeHash: "ab".repeat(32), feeReserve: "0" },
        { slot: 30, name: "Other", state: "ready", version: 1, codeHash: "ab".repeat(32), feeReserve: null },
    ]);
});

test("node status labels a dormant contract", () => {
    expect(contractLabel(entry({ feeReserve: "0" }))).toBe("Counter@29 (dormant)");
    expect(contractLabel(entry({ feeReserve: "5" }))).toBe("Counter@29");
    expect(contractLabel(entry({ constructed: false }))).toBe("Counter@29 (armed)");
});

test("a run of empty slots collapses to one table row while deployed slots keep their own", () => {
    const empty = (index: number) => entry({ index, armed: false, constructed: false, name: "", codeHash: "" });
    const rows = lsTableRows([entry({ index: 29 }), empty(30), empty(31), empty(32), entry({ index: 33, name: "Vault" }), empty(34)]);

    expect(rows.map((row) => row.cells[0])).toEqual(["29", "30–32", "33", "34"]);
    expect(rows[1].cells[2]).toBe("empty ×3");
    expect(rows[1].state).toBe("empty");
    expect(rows[3].cells[2]).toBe("empty");
});
