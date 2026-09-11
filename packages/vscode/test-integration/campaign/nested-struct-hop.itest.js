// Isolates one shape: a member hop through a nested struct that a callee contract defines and spells
// bare inside its own input struct (`Vault::Get_input::detail`, of type `Vault::Tag`).
//
// The same receiver is completed from a contract document and from a gtest, which take different
// resolution paths, so the pair says which path is at fault rather than only that something is wrong.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, open, settle, settledLabels, completionLabels } = require("../campaign-lib");

const DESK = "contracts/Desk.h";
const GTEST = "Desk.test.cpp";

async function withFilter(value, body) {
    const config = vscode.workspace.getConfiguration("qpi");
    const previous = config.get("completionFilter");
    await config.update("completionFilter", value, vscode.ConfigurationTarget.Workspace);
    try {
        return await body();
    } finally {
        await config.update("completionFilter", previous, vscode.ConfigurationTarget.Workspace);
    }
}

suite("campaign — nested struct hop", function () {
    this.timeout(180000);

    suiteSetup(async () => {
        await open(DESK);
        await clangdRunning({ timeout: 90000 });
    });

    test("contract document: locals.input.detail. should offer the struct's fields", async () => {
        const doc = await open(DESK);
        await settledLabels(doc, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 90000 });

        const onFilter = await settle(
            () => completionLabels(doc, "locals.input.detail.rank", "locals.input.detail."),
            (l) => l.includes("rank"),
            { timeout: 12000 },
        );
        console.log(`    filter=qpi  -> ${onFilter.value.length} items: ${onFilter.value.slice(0, 10).join(", ")}`);

        const offFilter = await withFilter("off", async () => {
            const r = await settle(
                () => completionLabels(doc, "locals.input.detail.rank", "locals.input.detail."),
                (l) => l.includes("rank"),
                { timeout: 12000 },
            );
            return r;
        });
        console.log(`    filter=off  -> ${offFilter.value.length} items: ${offFilter.value.slice(0, 10).join(", ")}`);

        // A control on the same receiver root: one hop less resolves correctly, so the buffer and the
        // language client are both healthy at this position.
        const control = await completionLabels(doc, "locals.input.history.setAll", "locals.input.");
        console.log(`    control locals. -> ${control.length} items: ${control.slice(0, 8).join(", ")}`);
        assert.ok(control.includes("detail"), `control: locals.input. should offer detail; got [${control.slice(0, 8).join(", ")}]`);

        assert.ok(
            onFilter.value.includes("rank") && onFilter.value.includes("bits"),
            `locals.input.detail. should offer the Tag fields; got ${onFilter.value.length} items [${onFilter.value.slice(0, 12).join(", ")}]`,
        );
    });

    test("gtest document: the identical receiver shape", async () => {
        const doc = await open(GTEST);
        await clangdRunning({ timeout: 90000 });

        const r = await settle(
            () => completionLabels(doc, "gi.detail.rank", "gi.detail."),
            (l) => l.includes("rank"),
            { timeout: 45000 },
        );
        console.log(`    gtest gi.detail. -> ${r.value.length} items: ${r.value.slice(0, 10).join(", ")}`);
        assert.ok(r.settled, `gtest gi.detail. should offer rank; got ${r.value.length} items [${r.value.slice(0, 12).join(", ")}]`);
    });
});
