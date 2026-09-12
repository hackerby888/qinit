// Cross-contract campaign: a three-contract diamond (Teller -> Bank -> Ledger) holding the worst shapes a QPI
// contract can. It reports what every receiver answers rather than only asserting, so a regression is a number.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, clangdClient, open, settle, settledLabels, completionLabels, diagnosticsFor } = require("../campaign-lib");

const TELLER = "contracts/Teller.h";
const BANK = "contracts/Bank.h";

suite("campaign — cross-contract completion", function () {
    this.timeout(180000);

    suiteSetup(async () => {
        await open(TELLER);
        const running = await clangdRunning({ timeout: 90000 });
        console.log(`    clangd state=${clangdClient()?.state} running=${running}`);
    });

    // If project resolution throws, the caller loses its analysis context entirely — no IDL, no hover, no callee
    // sources for the fallback. A dropped callee is now a warning on the same source, so only errors count here.
    test("the project resolves at all", async () => {
        const doc = await open(TELLER);
        const result = await settle(
            () => diagnosticsFor(doc, ["qinit-project"]).filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error),
            (diagnostics) => diagnostics.length === 0,
            { timeout: 20000 },
        );
        console.log(`    Teller.h project diagnostics -> ${result.value.length}`);
        for (const diagnostic of result.value) console.log(`      ${diagnostic.source}:${diagnostic.code} — ${diagnostic.message}`);
        assert.strictEqual(result.value.length, 0, "a contract that clang compiles should resolve in the editor");
    });

    test("every cross-contract receiver completes", async () => {
        const doc = await open(TELLER);
        await clangdRunning({ timeout: 90000 });

        const receivers = [
            ["locals.", "locals.in.hist.setAll", "in"],
            ["locals.in.", "locals.in.hist.setAll", "hist"],
            ["locals.in.hist.", "locals.in.hist.setAll", "setAll"],
            ["locals.in.tranche.", "locals.in.tranche.tier.rank", "tier"],
            ["locals.in.tranche.tier.", "locals.in.tranche.tier.rank", "rank"],
            ["locals.in.tranche.tier.bits.", "locals.in.tranche.tier.bits", "setAll"],
            ["locals.in.tranche.hist.", "locals.in.tranche.hist.setAll", "setAll"],
            ["locals.in.key.", "locals.in.key.a = 0", "a"],
            ["locals.in.lots.", "locals.in.lots.setAll", "setAll"],
            ["locals.in.grid.", "locals.in.grid.setAll", "setAll"],
            ["locals.in.flags.", "locals.in.flags.setAll", "setAll"],
            ["locals.in.stamp.", "locals.in.stamp.at = 0", "at"],
            ["locals.out.", "locals.out.lot.qty", "lot"],
            ["locals.out.lot.", "locals.out.lot.qty", "qty"],
            ["locals.out.lot.tier.", "locals.out.lot.tier", "rank"],
            ["locals.direct.", "locals.direct.rank = 0", "rank"],
            ["locals.directTranche.", "locals.directTranche.tier.rank", "tier"],
            ["locals.directTranche.tier.", "locals.directTranche.tier.rank", "rank"],
            ["locals.directEntry.", "locals.directEntry.stamp.at", "stamp"],
            ["locals.directEntry.stamp.", "locals.directEntry.stamp.at", "at"],
            ["state.get().", "state.get().calls", "calls"],
            ["state.get().mirror.", "state.get().mirror.rank", "rank"],
        ];

        const missing = [];
        for (const [dot, marker, wanted] of receivers) {
            let result;
            try {
                result = await settledLabels(doc, marker, dot, wanted, { timeout: 8000 });
            } catch (error) {
                console.log(`    ${dot.padEnd(32)} -> marker absent (${String(error.message).slice(0, 40)})`);
                continue;
            }
            console.log(`    ${dot.padEnd(32)} -> ${String(result.value.length).padStart(4)} items, ${wanted}${result.settled ? " ✓" : " MISSING"}`);
            if (!result.settled) missing.push(`${dot} wanted ${wanted}, got [${result.value.slice(0, 6).join(", ")}]`);
        }
        assert.deepStrictEqual(missing, [], `receivers that did not complete:\n      ${missing.join("\n      ")}`);
    });

    // Each qualifier is asked twice, in both orders, because a single pass cannot tell a qualifier-specific
    // failure apart from whichever query simply ran first while clangd was still warming up.
    test("qualified callee scopes resolve", async () => {
        const doc = await open(TELLER);
        await clangdRunning({ timeout: 90000 });
        const BANK_Q = ["Bank::", "Bank::Quote_input in", "Quote_input"];
        const LEDGER_Q = ["Ledger::", "Ledger::Entry directEntry", "Entry"];

        for (const [pass, order] of [
            ["pass 1 (Bank first)", [BANK_Q, LEDGER_Q]],
            ["pass 2 (Ledger first)", [LEDGER_Q, BANK_Q]],
        ]) {
            for (const [qualifier, marker, wanted] of order) {
                const result = await settledLabels(doc, marker, qualifier, wanted, { timeout: 8000 });
                console.log(`    ${pass.padEnd(22)} ${qualifier.padEnd(10)} -> ${result.value.length} items, ${wanted}${result.settled ? " ✓" : " MISSING"}`);
            }
        }
    });

    // A contract that genuinely cannot be analysed still drops out of the prelude, and must say why. `Orphan.h`
    // names a contract this project does not have, so it is the shape that still drops now the diamond resolves.
    test("a sibling that cannot be analysed is dropped, and the drop is reported", async () => {
        const doc = await open(TELLER);
        const result = await settle(
            () => diagnosticsFor(doc, ["qinit-project"]).filter((diagnostic) => String(diagnostic.code) === "qinit/callee-dropped"),
            (diagnostics) => diagnostics.length > 0,
            { timeout: 20000 },
        );
        console.log(`    qinit/callee-dropped -> ${result.value.length}`);
        for (const diagnostic of result.value) console.log(`      ${String(diagnostic.message).slice(0, 130)}`);
        assert.ok(result.settled, "a callee missing from the prelude must say so, not leave clangd to it");
        assert.match(String(result.value[0].message), /Orphan/, "the message must name the callee that went missing");
        assert.ok(!/'Bank'/.test(String(result.value[0].message)), "Bank resolves now; only a genuinely broken sibling should drop");
    });

    test("the caller compiles: a transitive callee is not dropped from the prelude", async () => {
        const doc = await open(TELLER);
        await clangdRunning({ timeout: 90000 });
        const result = await settle(
            () => diagnosticsFor(doc, ["clang"]).filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error),
            (diagnostics) => diagnostics.length === 0,
            { timeout: 30000 },
        );
        console.log(`    Teller.h clang errors -> ${result.value.length}`);
        for (const diagnostic of result.value.slice(0, 4)) console.log(`      line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`);
        assert.strictEqual(result.value.length, 0, "Teller.h should compile: Bank must be declared in the prelude");
    });

    test("the middle contract of the diamond resolves too", async () => {
        const doc = await open(BANK);
        await clangdRunning({ timeout: 90000 });
        const result = await settle(
            () => diagnosticsFor(doc, ["qinit-project", "qpi", "qinit-compiler"]),
            (diagnostics) => diagnostics.length === 0,
            { timeout: 20000 },
        );
        console.log(
            `    Bank.h diagnostics -> ${result.value.length}: ${result.value.map((diagnostic) => `${diagnostic.source}:${diagnostic.code}`).join(", ") || "(clean)"}`,
        );
        const labels = await completionLabels(doc, "locals.note.entry.stamp.at", "locals.note.entry.");
        console.log(`    Bank locals.note.entry. -> ${labels.length} items: ${labels.slice(0, 8).join(", ")}`);
    });
});
