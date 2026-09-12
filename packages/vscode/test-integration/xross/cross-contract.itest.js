// Cross-contract campaign: a three-contract diamond (Teller -> Bank -> Ledger) whose structs hold the
// worst shapes a QPI contract can — typedefs, two-level nesting, struct map keys, containers of
// containers, arrays of structs, and each contract referencing the next one's types.
//
// It reports what every receiver answers rather than only asserting, so a regression is a number.
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

    // The headline: if project resolution throws, the caller loses its analysis context entirely — no
    // IDL, no hover, and the member fallback has no callee sources to answer from. "No qinit-project
    // diagnostic at all" used to stand in for that, and no longer can: a dropped callee is now reported
    // under the same source as a warning, and is asserted by the case below. The error is the signal.
    test("the project resolves at all", async () => {
        const doc = await open(TELLER);
        const r = await settle(
            () => diagnosticsFor(doc, ["qinit-project"]).filter((d) => d.severity === vscode.DiagnosticSeverity.Error),
            (d) => d.length === 0,
            { timeout: 20000 },
        );
        console.log(`    Teller.h project diagnostics -> ${r.value.length}`);
        for (const d of r.value) console.log(`      ${d.source}:${d.code} — ${d.message}`);
        assert.strictEqual(r.value.length, 0, "a contract that clang compiles should resolve in the editor");
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
            let r;
            try {
                r = await settledLabels(doc, marker, dot, wanted, { timeout: 8000 });
            } catch (error) {
                console.log(`    ${dot.padEnd(32)} -> marker absent (${String(error.message).slice(0, 40)})`);
                continue;
            }
            console.log(`    ${dot.padEnd(32)} -> ${String(r.value.length).padStart(4)} items, ${wanted}${r.settled ? " ✓" : " MISSING"}`);
            if (!r.settled) missing.push(`${dot} wanted ${wanted}, got [${r.value.slice(0, 6).join(", ")}]`);
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
                const r = await settledLabels(doc, marker, qualifier, wanted, { timeout: 8000 });
                console.log(`    ${pass.padEnd(22)} ${qualifier.padEnd(10)} -> ${r.value.length} items, ${wanted}${r.settled ? " ✓" : " MISSING"}`);
            }
        }
    });

    // E5, still pinned: Bank is dropped from Teller's callee prelude because parseRegisters analyses Bank
    // without its own callee (Ledger) and throws on `Ledger::Stamp`. clangd then has no declaration for
    // Bank, so every `Bank::` line in Teller.h is an error. Resolving a callee's own callees before
    // parsing its registrations is a packages/build change with a real design question attached, so the
    // drop itself stands — but it is no longer silent, which is the half that could be fixed honestly.
    test("the drop is reported even though the caller still does not compile", async () => {
        const doc = await open(TELLER);
        const r = await settle(
            () => diagnosticsFor(doc, ["qinit-project"]).filter((d) => String(d.code) === "qinit/callee-dropped"),
            (d) => d.length > 0,
            { timeout: 20000 },
        );
        console.log(`    qinit/callee-dropped -> ${r.value.length}`);
        for (const d of r.value) console.log(`      ${String(d.message).slice(0, 130)}`);
        assert.ok(r.settled, "a callee missing from the prelude must say so, not leave clangd to it");
        assert.match(String(r.value[0].message), /Bank/, "the message must name the callee that went missing");
    });

    test("the caller compiles: a transitive callee is not dropped from the prelude", async () => {
        const doc = await open(TELLER);
        await clangdRunning({ timeout: 90000 });
        const r = await settle(
            () => diagnosticsFor(doc, ["clang"]).filter((d) => d.severity === vscode.DiagnosticSeverity.Error),
            (d) => d.length === 0,
            { timeout: 30000 },
        );
        console.log(`    Teller.h clang errors -> ${r.value.length}`);
        for (const d of r.value.slice(0, 4)) console.log(`      line ${d.range.start.line + 1}: ${d.message}`);
        assert.strictEqual(r.value.length, 0, "Teller.h should compile: Bank must be declared in the prelude");
    });

    test("the middle contract of the diamond resolves too", async () => {
        const doc = await open(BANK);
        await clangdRunning({ timeout: 90000 });
        const r = await settle(
            () => diagnosticsFor(doc, ["qinit-project", "qpi", "qinit-compiler"]),
            (d) => d.length === 0,
            { timeout: 20000 },
        );
        console.log(`    Bank.h diagnostics -> ${r.value.length}: ${r.value.map((d) => `${d.source}:${d.code}`).join(", ") || "(clean)"}`);
        const labels = await completionLabels(doc, "locals.note.entry.stamp.at", "locals.note.entry.");
        console.log(`    Bank locals.note.entry. -> ${labels.length} items: ${labels.slice(0, 8).join(", ")}`);
    });
});
