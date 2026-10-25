// a command's contract file comes from its argument or qinit.json only; a contract name never implies a file.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContractName, projectContractPath } from "../../src/config";

function project(): string {
    return mkdtempSync(join(tmpdir(), "qinit-contract-path-"));
}

test("the argument wins, then qinit.json's contract", () => {
    const cwd = project();
    try {
        expect(projectContractPath("build", "other/X.h", { contract: "contracts/A.h" }, cwd)).toBe(join(cwd, "other/X.h"));
        expect(projectContractPath("build", undefined, { contract: "contracts/A.h" }, cwd)).toBe(join(cwd, "contracts/A.h"));
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

// the contract is named Counter, but its file is MyCounter.h: guessing contracts/Counter.h would build the wrong file or none.
test("a contract name alone does not name its file", () => {
    const cwd = project();
    try {
        mkdirSync(join(cwd, "contracts"));
        writeFileSync(join(cwd, "contracts", "MyCounter.h"), "");
        writeFileSync(join(cwd, "qinit.json"), JSON.stringify({ contractName: "Counter" }));

        expect(() => projectContractPath("test", undefined, { contractName: "Counter" }, cwd)).toThrow(
            'qinit.json names no contract file — set "contract" there, or pass `qinit test <file.h>`',
        );
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("outside a project the error says so and names the command", () => {
    const cwd = project();
    try {
        expect(() => projectContractPath("gtest", undefined, {}, cwd)).toThrow(
            `not in a qinit project (no qinit.json in ${cwd}) — cd into one, or pass \`qinit gtest <file.h>\``,
        );
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

// the struct is read from the header and never typed; the deploy name defaults to it and may differ, so a copy of core's QUtil.h ships as MyQutil.
test("the state type is the declared struct and the deploy name may differ from it", () => {
    const cwd = project();
    try {
        const file = join(cwd, "MyCounter.h");
        writeFileSync(file, "struct CounterV2 : public ContractBase {};");

        expect(projectContractName(file, {}, {}, true)).toEqual({ name: "CounterV2", stateType: "CounterV2" });
        expect(projectContractName(file, { contractName: "CounterV2", stateType: "CounterV2" }, { contractName: "CounterV2" }, true)).toEqual({ name: "CounterV2", stateType: "CounterV2" });
        expect(projectContractName(file, {}, { contractName: "Counter" }, true)).toEqual({ name: "Counter", stateType: "CounterV2" });
        // a header named on the command line is not the one qinit.json names
        expect(projectContractName(file, {}, { contractName: "Counter" }, false)).toEqual({ name: "CounterV2", stateType: "CounterV2" });
        expect(projectContractName(file, { contractName: "Counter" }, {}, false)).toEqual({ name: "Counter", stateType: "CounterV2" });
        expect(() => projectContractName(file, { stateType: "Other" }, {}, false)).toThrow(`--state-type "Other" ≠ struct CounterV2`);
        // the deploy name becomes a class and a gtest suite
        expect(() => projectContractName(file, { contractName: "my-counter" }, {}, false)).toThrow(`contract name "my-counter" is not an identifier`);

        writeFileSync(file, "struct Helper {};");
        expect(() => projectContractName(file, { contractName: "Helper" }, {}, false)).toThrow("no contract struct in");
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

// core wraps every include in `#define CONTRACT_STATE_TYPE <Name>`, so a struct named with the macro takes the deploy name as its struct.
test("a macro-named struct takes the deploy name as its state type", () => {
    const cwd = project();
    try {
        const file = join(cwd, "Legacy.h");
        writeFileSync(file, "struct CONTRACT_STATE_TYPE : public ContractBase {};");
        expect(projectContractName(file, {}, { contractName: "Legacy" }, true)).toEqual({ name: "Legacy", stateType: "Legacy" });
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("a struct name the deploy message cannot carry is refused", () => {
    const cwd = project();
    try {
        const file = join(cwd, "Long.h");
        writeFileSync(file, `struct ${"L".repeat(31)} : public ContractBase {};`);
        expect(projectContractName(file, {}, {}, false).name).toBe("L".repeat(31));
        writeFileSync(file, `struct ${"L".repeat(32)} : public ContractBase {};`);
        expect(() => projectContractName(file, {}, {}, false)).toThrow("is 32 characters");
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
