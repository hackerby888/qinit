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

// MyCounter.h declaring CounterV2 under contractName "Counter" built with the typescript compiler and failed with clang.
test("a contract's name is the struct it declares, and a name that disagrees is refused", () => {
    const cwd = project();
    try {
        const file = join(cwd, "MyCounter.h");
        writeFileSync(file, "struct CounterV2 : public ContractBase {};");

        expect(projectContractName(file, {}, {}, true)).toBe("CounterV2");
        expect(projectContractName(file, { contractName: "CounterV2", stateType: "CounterV2" }, { contractName: "CounterV2" }, true)).toBe("CounterV2");
        expect(() => projectContractName(file, {}, { contractName: "Counter" }, true)).toThrow(
            `qinit.json contractName "Counter" ≠ struct CounterV2 in MyCounter.h`,
        );
        // a header named on the command line is not the one qinit.json names
        expect(projectContractName(file, {}, { contractName: "Counter" }, false)).toBe("CounterV2");
        expect(() => projectContractName(file, { contractName: "Counter" }, {}, false)).toThrow(`--contract-name "Counter" ≠ struct CounterV2`);
        expect(() => projectContractName(file, { stateType: "Other" }, {}, false)).toThrow(`--state-type "Other" ≠ struct CounterV2`);

        writeFileSync(file, "struct Helper {};");
        expect(() => projectContractName(file, { contractName: "Helper" }, {}, false)).toThrow("no contract struct in");
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("a struct name the deploy message cannot carry is refused", () => {
    const cwd = project();
    try {
        const file = join(cwd, "Long.h");
        writeFileSync(file, `struct ${"L".repeat(31)} : public ContractBase {};`);
        expect(projectContractName(file, {}, {}, false)).toBe("L".repeat(31));
        writeFileSync(file, `struct ${"L".repeat(32)} : public ContractBase {};`);
        expect(() => projectContractName(file, {}, {}, false)).toThrow("is 32 characters");
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
