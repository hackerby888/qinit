// The editing session, not the snapshot. Everything here happens to a document that is already open,
// because that is where a contract developer actually lives: they rename, delete, retype and undo, and
// the extension regenerates only on open and save (`extension.ts` wires regenerateDocument to
// onDidOpenTextDocument/onDidSaveTextDocument, while onDidChangeTextDocument only reschedules
// diagnostics). The window between an edit and a save is therefore a real state a developer sees, and
// these cases assert what is shown inside it rather than only at the endpoints.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, open, settle, replaceDocument, diagnosticsFor, completionLabels, sleep } = require("../campaign-lib");

const METER = "contracts/Meter.h";

/** qpi/qinit-compiler/qinit-project diagnostics: the extension's own, not clangd's. */
const ownDiagnostics = (doc) => diagnosticsFor(doc, ["qpi", "qinit-compiler", "qinit-project"]);
const codesOf = (list) => [...new Set(list.map((d) => String(d.code)))].sort();

/** Settles on the extension's own diagnostics reaching a shape, and always reports what it saw. */
async function settleOwn(doc, ok, opts = {}) {
    return settle(() => ownDiagnostics(doc), ok, { timeout: 15000, interval: 400, ...opts });
}

suite("live — the editing session", function () {
    this.timeout(240000);

    let pristine;

    suiteSetup(async () => {
        pristine = (await open(METER)).getText();
        await clangdRunning({ timeout: 90000 });
    });

    // Each case mutates the same buffer, so every one restores it or the next inherits the wreck.
    teardown(async () => {
        const doc = await open(METER);
        await replaceDocument(doc, pristine);
        await doc.save();
        await sleep(300);
    });

    test("the untouched contract is clean to start", async () => {
        const doc = await open(METER);
        const r = await settleOwn(doc, (d) => d.length === 0);
        console.log(`    baseline own-diagnostics -> ${r.value.length} ${codesOf(r.value).join(",")}`);
        assert.deepStrictEqual(codesOf(r.value), [], "a valid contract must start clean");
    });

    // De-classifying must clear every squiggle the contract had: the file is no longer a contract, so
    // analysisFor returns nothing and QpiDiagnostics.clear is the only correct outcome.
    test("deleting ': public ContractBase' clears every stale squiggle", async () => {
        const doc = await open(METER);
        // First make it dirty in a way that definitely squiggles, so there is something to clear.
        await replaceDocument(doc, doc.getText().replace("uint64 calls;", "double calls;"));
        const dirty = await settleOwn(doc, (d) => d.length > 0);
        console.log(`    with a double in state -> ${codesOf(dirty.value).join(",") || "(none)"}`);

        await replaceDocument(doc, doc.getText().replace("struct Meter : public ContractBase", "struct Meter"));
        const cleared = await settleOwn(doc, (d) => d.length === 0);
        console.log(`    after de-classifying   -> ${cleared.value.length} (${cleared.ms} ms)`);
        assert.deepStrictEqual(codesOf(cleared.value), [], "a non-contract must carry no QPI diagnostics");
    });

    // Renaming the state type is the single most common refactor and it changes the identity the
    // prefix header was generated for.
    test("renaming the contract type does not strand a diagnostic", async () => {
        const doc = await open(METER);
        const renamed = doc
            .getText()
            .replace("struct Meter2", "struct Gauge2")
            .replace("struct Meter : public ContractBase", "struct Gauge : public ContractBase");
        await replaceDocument(doc, renamed);
        const r = await settleOwn(doc, (d) => d.length === 0);
        console.log(`    renamed Meter->Gauge, own-diagnostics -> ${r.value.length} ${codesOf(r.value).join(",") || "(clean)"}`);
        for (const d of r.value.slice(0, 5)) console.log(`      ${d.source}:${d.code} — ${String(d.message).slice(0, 90)}`);
        // The rename makes the file disagree with qinit.json's contractName; whatever the extension
        // decides, it must not be a stale diagnostic pointing at a name no longer in the buffer.
        const stale = r.value.filter((d) => String(d.message).includes("Meter"));
        assert.deepStrictEqual(stale, [], "no diagnostic may name the type the buffer no longer declares");
    });

    // Typed from empty, one prefix at a time: no intermediate state may throw or wedge the analyzer.
    test("typing a contract from empty never wedges the analyzer", async () => {
        const doc = await open(METER);
        const full = pristine;
        const marks = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map((f) => Math.floor(full.length * f));
        for (const mark of marks) {
            await replaceDocument(doc, full.slice(0, mark));
            await sleep(250);
            const shown = ownDiagnostics(doc);
            console.log(`    ${String(mark).padStart(5)} chars -> ${shown.length} diagnostics ${codesOf(shown).slice(0, 3).join(",")}`);
            // The analyzer may legitimately complain about a half-typed file; it may not crash the host.
            assert.ok(Array.isArray(shown), "diagnostics must remain readable while typing");
        }
        const done = await settleOwn(doc, (d) => d.length === 0);
        assert.deepStrictEqual(codesOf(done.value), [], "the finished file must settle clean");
    });

    // A registration commented out without saving: the buffer says the entry is gone, and the IDL the
    // hover reads is rebuilt from the buffer, not from disk.
    test("commenting out a registration is visible before saving", async () => {
        const doc = await open(METER);
        await replaceDocument(doc, doc.getText().replace("REGISTER_USER_PROCEDURE(Bump, 2);", "// REGISTER_USER_PROCEDURE(Bump, 2);"));
        const r = await settleOwn(doc, (d) => d.some((x) => String(x.code) === "qpi/unregistered"), { timeout: 12000 });
        console.log(`    unsaved unregister -> ${codesOf(r.value).join(",") || "(silent)"} after ${r.ms} ms`);
        assert.ok(r.settled, `an unregistered entry must be reported from the buffer, got [${codesOf(r.value).join(", ")}]`);
    });

    // A big paste followed by undo: the analyzer must track the buffer both ways.
    test("a large paste and undo returns to clean", async () => {
        const doc = await open(METER);
        const noise = Array.from({ length: 400 }, (_, i) => `// padding line ${i} — a developer pasting a block of commentary`).join("\n");
        await replaceDocument(doc, `${noise}\n${pristine}`);
        const pasted = await settleOwn(doc, (d) => d.length === 0, { timeout: 20000 });
        console.log(`    after a ${noise.length}-char paste -> ${pasted.value.length} diagnostics (${pasted.ms} ms)`);
        assert.deepStrictEqual(codesOf(pasted.value), [], "comment padding must not change the verdict");

        await replaceDocument(doc, pristine);
        const undone = await settleOwn(doc, (d) => d.length === 0);
        assert.deepStrictEqual(codesOf(undone.value), [], "undo must return to clean");
    });

    // Completion during a restart is the race a developer hits when clangd is reindexing.
    test("completion during clangd.restart resolves or declines, never throws", async () => {
        const doc = await open(METER);
        await clangdRunning({ timeout: 90000 });
        const restarting = vscode.commands.executeCommand("clangd.restart");
        const during = [];
        for (let i = 0; i < 5; i++) {
            try {
                during.push((await completionLabels(doc, "locals.scratch.tick", "locals.scratch.")).length);
            } catch (error) {
                during.push(`THREW:${String(error.message).slice(0, 40)}`);
            }
            await sleep(200);
        }
        await restarting;
        console.log(`    completion during restart -> ${during.join(", ")}`);
        assert.deepStrictEqual(
            during.filter((x) => typeof x === "string"),
            [],
            "a completion request during a restart must not throw",
        );

        await clangdRunning({ timeout: 90000 });
        const after = await settle(
            () => completionLabels(doc, "locals.scratch.tick", "locals.scratch."),
            (labels) => labels.includes("tick"),
            { timeout: 30000 },
        );
        console.log(`    after restart -> ${after.value.length} items, tick${after.settled ? " ✓" : " MISSING"}`);
        assert.ok(after.settled, `completion must recover after a restart, got [${after.value.slice(0, 8).join(", ")}]`);
    });
});

// Project resolution throws for several ordinary shapes — a callee that does not exist yet, a slot
// outside the dynamic window, a qinit.json pointing at a missing file — and the throw is published as
// `qinit/project-dependencies`, which is how the developer learns what went wrong.
//
// E11, pinned failing: that only holds for the contract qinit.json names. The identical mistake in any
// other contract of the same project is rolled back by the bare `catch {}` in project-dependencies.ts
// (the sibling walk), so the file silently degrades to standalone with no callees and the developer is
// left with raw clang "use of undeclared identifier" and nothing naming the cause.
suite("live — project shapes", function () {
    this.timeout(240000);

    const CALLER = "contracts/Caller.h";
    const CALLEE = "contracts/Missing.h";
    const fs = require("node:fs");
    const { wsUri } = require("../campaign-lib");

    const CALLER_SOURCE = `using namespace QPI;

struct Caller2
{
};

struct Caller : public ContractBase
{
    struct StateData { uint64 calls; };
    struct Go_input {};
    struct Go_output {};
    struct Go_locals
    {
        Missing::Read_input in;
        Missing::Read_output out;
    };
    PUBLIC_PROCEDURE_WITH_LOCALS(Go)
    {
        CALL_OTHER_CONTRACT_FUNCTION(Missing, Read, locals.in, locals.out);
        state.mut().calls += 1;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Go, 1);
    }
};
`;

    const CALLEE_SOURCE = `using namespace QPI;

struct Missing2
{
};

struct Missing : public ContractBase
{
    struct StateData { uint64 reads; };
    struct Read_input {};
    struct Read_output { uint64 value; };
    PUBLIC_FUNCTION(Read)
    {
        output.value = state.get().reads;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
    }
};
`;

    const remove = (name) => {
        try {
            fs.unlinkSync(wsUri(name).fsPath);
        } catch {}
    };

    teardown(() => {
        remove(CALLER);
        remove(CALLEE);
    });

    test("a callee referenced before its file exists is reported, then clears when it appears", async () => {
        fs.writeFileSync(wsUri(CALLER).fsPath, CALLER_SOURCE);
        const doc = await open(CALLER);

        const reported = await settleOwn(doc, (d) => d.some((x) => String(x.code) === "qinit/project-dependencies"), { timeout: 20000 });
        const message = String(reported.value.find((d) => String(d.code) === "qinit/project-dependencies")?.message ?? "");
        console.log(`    missing callee -> ${codesOf(reported.value).join(",") || "(silent)"} after ${reported.ms} ms`);
        const clang = diagnosticsFor(doc, ["clang"]).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
        console.log(`      clang says: ${clang.length} errors, first: ${String(clang[0]?.message ?? "(none)").slice(0, 70)}`);
        console.log(`      message: ${message.slice(0, 130)}`);
        assert.ok(reported.settled, `a callee with no source must be reported, got [${codesOf(reported.value).join(", ")}]`);
        assert.ok(message.includes("Missing"), `the message must name the callee it cannot find: ${message}`);

        // Now the developer creates the file. Saving the caller is what re-resolves the project.
        fs.writeFileSync(wsUri(CALLEE).fsPath, CALLEE_SOURCE);
        await doc.save();
        const cleared = await settleOwn(doc, (d) => d.length === 0, { timeout: 30000 });
        console.log(`    after creating the callee -> ${cleared.value.length} diagnostics (${cleared.ms} ms) ${codesOf(cleared.value).join(",")}`);
        assert.deepStrictEqual(codesOf(cleared.value), [], "creating the callee must clear the resolution error");
    });
});
