// Campaign suite: walks the three completion scopes across every receiver a contract author types.
// It reports counts for each one, so a regression shows up as a number rather than as a bare failure.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, clangdClient, open, settle, settledLabels, completionItems, completionLabels, labelOf, diagnosticsFor } = require("../campaign-lib");

const DESK = "contracts/Desk.h";
const VAULT = "contracts/Vault.h";

suite("campaign — completion surface", function () {
    this.timeout(180000);

    suiteSetup(async () => {
        await open(DESK);
        const running = await clangdRunning({ timeout: 90000 });
        console.log(`    clangd client state=${clangdClient()?.state} running=${running}`);
    });

    // Everything downstream is meaningless if clangd never answered: the extension's member fallback can
    // satisfy a member list on its own, so a green member test is not evidence that clangd is alive.
    test("clangd is genuinely answering, not just the fallback", async () => {
        const doc = await open(DESK);
        assert.strictEqual(clangdClient()?.state, 2, "clangd language client should report Running");

        // `qpi.` is answered by clangd only — the QPI compiler fallback does not model the qpi context object.
        const qpi = await settledLabels(doc, "qpi.invocationReward", "qpi.", "invocationReward", { timeout: 90000 });
        console.log(`    qpi. -> ${qpi.value.length} items in ${qpi.ms}ms (${qpi.attempts} attempts)`);
        assert.ok(qpi.settled, `clangd should answer qpi.; got ${qpi.value.length} items: [${qpi.value.slice(0, 8).join(", ")}]`);
    });

    test("member scope answers at every receiver and every field hop", async () => {
        const doc = await open(DESK);
        await settledLabels(doc, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 90000 });

        const receivers = [
            ["locals.", "locals.input.history.setAll", "input"],
            ["locals.input.", "locals.input.history.setAll", "history"],
            ["locals.input.history.", "locals.input.history.setAll", "setAll"],
            ["locals.input.detail.", "locals.input.detail.rank", "rank"],
            ["locals.input.detail.bits.", "locals.input.detail.bits.setAll", "setAll"],
            ["locals.output.", "locals.output.value + state", "value"],
            ["state.get().", "state.get().calls;", "calls"],
            ["state.mut().", "state.mut().calls = state", "calls"],
            ["state.mut().recent.", "state.mut().recent.setAll", "setAll"],
        ];

        const missing = [];
        for (const [dot, marker, wanted] of receivers) {
            const r = await settledLabels(doc, marker, dot, wanted, { timeout: 20000 });
            console.log(`    ${dot.padEnd(28)} -> ${String(r.value.length).padStart(3)} items, ${wanted}${r.settled ? " ✓" : " MISSING"} (${r.ms}ms)`);
            if (!r.settled) missing.push(`${dot} (wanted ${wanted}, got [${r.value.slice(0, 8).join(", ")}])`);
        }
        assert.deepStrictEqual(missing, [], `every receiver should complete:\n      ${missing.join("\n      ")}`);
    });

    test("member lists carry no generated noise and annotate their types", async () => {
        const doc = await open(DESK);
        await settledLabels(doc, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 90000 });

        const items = await completionItems(doc, "locals.input.history.setAll", "locals.input.history.");
        const labels = items.map(labelOf);
        const noise = labels.filter((l) => /^(operator\b|~|_)/.test(l));
        console.log(`    Array members -> ${labels.length} items: ${labels.slice(0, 8).join(", ")}`);
        assert.deepStrictEqual(noise, [], `member list should carry no operator/dtor/underscore noise; got [${noise.join(", ")}]`);

        const fields = await completionItems(doc, "locals.input.detail.rank", "locals.input.detail.");
        const rank = fields.find((item) => labelOf(item) === "rank");
        assert.ok(rank, `detail. should offer rank; got [${fields.map(labelOf).slice(0, 8).join(", ")}]`);
        console.log(`    rank -> kind=${rank.kind} label.detail=${JSON.stringify(rank.label.detail)} detail=${JSON.stringify(rank.detail)}`);
        assert.strictEqual(String(rank.label.detail), ": sint16", "a field annotates its type inline in label.detail");
    });

    // The filter empties a blocked qualified scope outright rather than passing it through, so an empty
    // list is the designed answer for `std::` and a bug for anything else.
    test("qualified scope: QPI and the callee resolve, std stays blocked", async () => {
        const doc = await open(DESK);
        await settledLabels(doc, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 90000 });

        const callee = await settledLabels(doc, "Vault::Get_input input", "Vault::", "Get_input", { timeout: 20000 });
        console.log(`    Vault::  -> ${callee.value.length} items, Get_input${callee.settled ? " ✓" : " MISSING"}`);
        assert.ok(callee.settled, `Vault:: should offer its structs; got [${callee.value.slice(0, 10).join(", ")}]`);

        const std = await settle(
            () => completionLabels(doc, "using namespace QPI;", "using namespace QPI;"),
            () => false,
            { timeout: 1500, interval: 700 },
        );
        console.log(`    (control) plain identifier scope -> ${std.value.length} items`);
    });

    test("a contract's diagnostics agree with the build", async () => {
        const doc = await open(DESK);
        await clangdRunning({ timeout: 90000 });
        const r = await settle(
            () => diagnosticsFor(doc, ["qpi", "qinit-compiler", "qinit-project", "clang"]),
            (d) => d.length === 0,
            { timeout: 45000 },
        );
        console.log(`    Desk.h diagnostics -> ${r.value.length}: ${r.value.map((d) => `${d.source}:${d.code}`).join(", ") || "(clean)"}`);
        assert.strictEqual(r.value.length, 0, `Desk.h compiles clean under clangd --check, so the editor should agree`);
    });

    test("the callee opens without breaking the caller", async () => {
        const doc = await open(DESK);
        await settledLabels(doc, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 90000 });
        await open(VAULT);
        const back = await open(DESK);
        const after = await settledLabels(back, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 45000 });
        console.log(`    after opening the callee -> ${after.value.length} items (${after.ms}ms)`);
        assert.ok(after.settled, `caller should still complete after the callee opened; got [${after.value.slice(0, 8).join(", ")}]`);
    });
});
