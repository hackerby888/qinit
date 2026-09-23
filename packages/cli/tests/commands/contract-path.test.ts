// a command's contract file comes from its argument or qinit.json only; a contract name never implies a file.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContractPath } from "../../src/config";

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
