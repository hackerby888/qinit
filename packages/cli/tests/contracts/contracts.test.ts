// resolveContract is the single target-resolution path for call / ls / state: a name or index maps to the same contract, user entries shadowing system ones.
import { test, expect } from "bun:test";
import {
    missingContractMessage,
    notLoadedMessage,
    parseContractSlot,
    resolveContract,
    systemAsDyn,
    systemLoaded,
    type ContractSets,
} from "../../src/contracts/registry";

const user = (over: any = {}) => ({
    index: 100,
    name: "MyToken",
    armed: true,
    constructed: true,
    version: 0,
    codeHash: "",
    source: "USER_SRC",
    ...over,
});
const sys = (over: any = {}) => ({
    index: 1,
    name: "QX",
    stateType: "QX",
    file: "QX.h",
    source: "SYS_SRC",
    idl: { name: "QX", functions: [], procedures: [] } as any,
    ...over,
});
const sets = (over: Partial<ContractSets> = {}): ContractSets => ({
    user: [],
    system: [],
    ...over,
});

test("parseContractSlot accepts contract indices", () => {
    for (const [value, expected] of [
        [1, 1],
        ["29", 29],
        [" 29 ", 29],
        [1023, 1023],
    ] as const) {
        expect(parseContractSlot(value)).toBe(expected);
    }
});

test("parseContractSlot rejects invalid contract indices", () => {
    for (const value of [undefined, "", "   ", null, false, true, 0, -1, 1.5, 1024, "NaN", Number.NaN, Infinity]) {
        expect(() => parseContractSlot(value)).toThrow("contract slot must be an integer from 1 to 1023");
    }
});

test("resolveContract: matches a user contract by case-insensitive name", () => {
    const r = resolveContract("mytoken", sets({ user: [user()] as any }));

    expect(r).toEqual({ index: 100, name: "MyToken", kind: "user", source: "USER_SRC" });
});

test("resolveContract: matches by numeric index", () => {
    const r = resolveContract("1", sets({ system: [sys()] as any }));

    expect(r?.kind).toBe("system");
    expect(r?.index).toBe(1);
});

test("resolveContract: user contracts shadow system on an index/name collision", () => {
    const r = resolveContract("1", sets({ user: [user({ index: 1, name: "Mine" })] as any, system: [sys()] as any }));

    expect(r?.kind).toBe("user");
    expect(r?.name).toBe("Mine");
});

test("resolveContract: falls through to system when not a user contract", () => {
    const r = resolveContract("QX", sets({ user: [user()] as any, system: [sys()] as any }));

    expect(r?.kind).toBe("system");
    expect(r?.name).toBe("QX");
});

test("resolveContract: trims surrounding whitespace before matching", () => {
    const r = resolveContract("  MyToken  ", sets({ user: [user()] as any }));

    expect(r?.index).toBe(100);
});

test("resolveContract: an unmatched target resolves to null", () => {
    expect(resolveContract("ghost", sets({ user: [user()] as any, system: [sys()] as any }))).toBeNull();
});

test("resolveContract: a non-numeric target never matches an index by accident", () => {
    const r = resolveContract("notanumber", sets({ user: [user({ name: "" })] as any }));

    expect(r).toBeNull();
});

test("resolveContract: an unnamed user contract reports its index as the name", () => {
    const r = resolveContract("100", sets({ user: [user({ name: "" })] as any }));

    expect(r).toEqual({ index: 100, name: "100", kind: "user", source: "USER_SRC" });
});

test("systemAsDyn presents a system contract as an armed registry entry", () => {
    const c = sys({
        idl: {
            name: "QX",
            functions: [{ name: "Get", inputType: 1, inSize: 0, outSize: 8 }],
            procedures: [{ name: "Set", inputType: 2, inSize: 8, outSize: 0 }],
        },
    });
    const d = systemAsDyn(c as any);

    expect(d.index).toBe(1);
    expect(d.name).toBe("QX");
    expect(d.armed).toBe(true);
    expect(d.constructed).toBe(true);
    expect(d.source).toBe("SYS_SRC");
    expect(d.functions.map((f) => f.inputType)).toEqual([1]);
    expect(d.procedures.map((p) => p.inputType)).toEqual([2]);
});

test("a registry the node never answered is reported as unknown, not as empty", () => {
    const silent = sets({ nodeError: "node unreachable at http://127.0.0.1:41841 — is it running? (qinit node run)  [request timed out after 10000ms]" });

    expect(missingContractMessage(silent, "Probe")).toContain("the node did not answer");
    expect(missingContractMessage(silent, "Probe")).toContain("request timed out");
    expect(missingContractMessage(silent, "Probe")).not.toContain("no contract");

    // An answered, empty registry names the fix in both forms.
    expect(missingContractMessage(sets(), "Probe")).toBe(
        "no contract 'Probe' (deployed or system — `qinit system add <name>` loads a system contract on the simulator)",
    );
    expect(missingContractMessage(sets())).toBe("no contracts — deploy one, or `qinit system add <name>` to load a system contract on the simulator");
});

// the catalog lists every system contract; only the simulator can be missing one, and only it says so.
test("a system contract is loaded unless a simulator never added it", () => {
    const qx = sys();

    expect(resolveContract("QX", sets({ system: [qx], backend: "simulator" }))?.loaded).toBe(false);
    expect(resolveContract("QX", sets({ system: [qx], backend: "core" }))?.loaded).toBe(true);
    expect(resolveContract("QX", sets({ system: [qx] }))?.loaded).toBe(true);
    // one the simulator runs sits in its registry too, and resolves as that entry.
    expect(resolveContract("QX", sets({ user: [user({ index: 1, name: "QX", source: "" })], system: [qx], backend: "simulator" }))?.kind).toBe("user");
    expect(systemLoaded(sets({ backend: "simulator" }))).toBe(false);
    expect(notLoadedMessage("QX")).toBe("QX is not running on this simulator — qinit system add QX");
});

test("a state struct named as the contract points at the contract", () => {
    const qtry = sys({ index: 2, name: "QTRY", stateType: "QUOTTERY" });

    expect(missingContractMessage(sets({ system: [qtry] }), "QUOTTERY")).toBe("QUOTTERY is QTRY's state struct — use QTRY");
    expect(missingContractMessage(sets({ system: [qtry] }), "quottery")).toBe("QUOTTERY is QTRY's state struct — use QTRY");
    expect(missingContractMessage(sets({ system: [qtry] }), "Lottery")).toContain("no contract 'Lottery'");
});
