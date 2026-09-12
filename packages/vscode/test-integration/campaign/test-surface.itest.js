// Round 19: what the editor offers in a gtest versus in the contract it exercises. The hover and the code
// actions are registered for .cpp, but both read QpiDiagnostics, which applies only to contract documents.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, open, idlHoverAt, completionLabels, diagnosticsFor } = require("../campaign-lib");

const CONTRACT = "contracts/Desk.h";
const GTEST = "Desk.test.cpp";

const codeActionsAt = async (doc, marker) => {
    const offset = doc.getText().indexOf(marker);
    const position = doc.positionAt(offset < 0 ? 0 : offset);
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, new vscode.Range(position, position));
    return (actions ?? []).map((action) => action.title);
};

suite("campaign — the gtest surface", function () {
    this.timeout(180000);

    suiteSetup(async () => {
        await open(CONTRACT);
        await clangdRunning({ timeout: 90000 });
    });

    test("the IDL hover answers in the contract and is asked for in the gtest", async () => {
        const contract = await open(CONTRACT);
        const inContract = await idlHoverAt(contract, "REGISTER_USER_FUNCTION(Read, 1)", "REGISTER_USER_FUNCTION(".length);
        console.log(`    contract  'Read' -> ${inContract.replace(/\n/g, " | ") || "(no hover)"}`);

        const gtest = await open(GTEST);
        await clangdRunning({ timeout: 90000 });
        const inGtest = await idlHoverAt(gtest, "Desk::Read_input", "Desk::".length);
        console.log(`    gtest     'Read_input' -> ${inGtest.replace(/\n/g, " | ") || "(no hover)"}`);

        assert.notStrictEqual(inContract, "", "the contract document must hover its own registered entry");
    });

    test("what each surface reports: diagnostics, actions, completion", async () => {
        const rows = [];
        for (const [label, name, marker] of [
            ["contract", CONTRACT, "state.get()."],
            ["gtest", GTEST, "gi."],
        ]) {
            const doc = await open(name);
            await clangdRunning({ timeout: 90000 });
            const own = diagnosticsFor(doc, ["qpi", "qinit-compiler", "qinit-project"]);
            const actions = await codeActionsAt(doc, marker);
            let members = [];
            try {
                members = await completionLabels(doc, marker, marker);
            } catch {
                members = [];
            }
            rows.push({ label, diagnostics: own.length, actions: actions.length, completion: members.length });
            console.log(`    ${label.padEnd(9)} own-diagnostics ${own.length}, code actions ${actions.length}, completion at '${marker}' ${members.length}`);
        }

        const gtest = rows.find((row) => row.label === "gtest");
        console.log(`    -> a gtest gets completion (${gtest.completion}) but ${gtest.diagnostics} diagnostics and ${gtest.actions} actions`);
    });
});
