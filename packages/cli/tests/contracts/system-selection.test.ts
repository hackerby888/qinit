// qinit.json's system selection has to match what the node runs, or a restart silently drops contracts the developer added.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractIdlFile } from "@qinit/proto/contract-idl";
import { addSystemSelection, dependentsOf, describeDeployFailure, removeSystemSelection } from "../../src/contracts/system-selection";
import { serveEnvironment } from "../../src/ops/node";

function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "qinit-system-selection-"));
    return { path: join(dir, "qinit.json"), drop: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the selection merges, sorts, and keeps the rest of qinit.json", () => {
    const { path, drop } = scratch();
    try {
        writeFileSync(path, JSON.stringify({ rpc: "http://127.0.0.1:47241", system: ["QX"] }, null, 2) + "\n");

        expect(addSystemSelection(["QUTIL", "QX"], path)).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ rpc: "http://127.0.0.1:47241", system: ["QUTIL", "QX"] });

        expect(removeSystemSelection(["QX"], path)).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ rpc: "http://127.0.0.1:47241", system: ["QUTIL"] });
    } finally {
        drop();
    }
});

// a deploy from a bare directory reports the selection as unsaved; `qinit system add` is the command that owns the file.
test("a missing qinit.json is written only on request", () => {
    const { path, drop } = scratch();
    try {
        expect(addSystemSelection(["QX"], path)).toBe(false);
        expect(existsSync(path)).toBe(false);

        expect(addSystemSelection(["QX"], path, { create: true })).toBe(true);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ system: ["QX"] });
    } finally {
        drop();
    }
});

test("an out-of-memory deploy names the contract and how many are loaded", () => {
    expect(describeDeployFailure("GGWP", 27, new Error("direct-deploy failed: Out of memory"))).toBe(
        "GGWP: the simulator has no wasm memory left with 27 contracts loaded — restart it (qinit node stop && qinit node run) so it seeds them all, or add fewer",
    );
    expect(describeDeployFailure("GGWP", 3, new Error("slot occupied"))).toBe("GGWP: slot occupied");
});

const system = (index: number, name: string, stateType = name) => ({
    index,
    name,
    stateType,
    constructionEpoch: 0,
    file: `${name}.h`,
    source: "",
    idl: {} as any,
});
const deployed = (index: number, name: string, over: Record<string, unknown> = {}) => ({
    index,
    name,
    armed: true,
    constructed: true,
    version: 1,
    codeHash: "ab".repeat(32),
    functions: [],
    procedures: [],
    ...over,
});

test("dependents come from the idl file first, then the stored source, and match a struct name too", () => {
    const catalog = [system(1, "QX"), system(2, "QTRY", "QUOTTERY"), system(4, "QUTIL")];
    const idlFile = {
        version: 1,
        contracts: { "30": { name: "Lotto", slot: 30, dependencies: ["QUOTTERY"], codeHash: "ab".repeat(32) } },
    } as unknown as ContractIdlFile;
    const registry = [
        deployed(30, "Lotto"),
        deployed(31, "Sysprobe", {
            source: "struct Sysprobe : public ContractBase { PUBLIC_FUNCTION(F) { CALL_OTHER_CONTRACT_FUNCTION(QX, Fees, input, output); } };",
        }),
        deployed(32, "Alone", { source: "struct Alone : public ContractBase {};" }),
        deployed(1, "QX"),
    ];

    expect(dependentsOf([catalog[1]], registry, idlFile, catalog)).toEqual([{ name: "Lotto", index: 30, uses: "QUOTTERY" }]);
    expect(dependentsOf([catalog[0]], registry, idlFile, catalog)).toEqual([{ name: "Sysprobe", index: 31, uses: "QX" }]);
    expect(dependentsOf([catalog[2]], registry, idlFile, catalog)).toEqual([]);
});

test("the spawned simulator takes the bounds-checked wasm memory path", () => {
    expect(serveEnvironment("/core").BUN_JSC_useWasmFastMemory).toBe("0");
    expect(serveEnvironment("/core").QINIT_CORE).toBe("/core");
    expect(serveEnvironment().QINIT_CORE).toBe(process.env.QINIT_CORE);
});
