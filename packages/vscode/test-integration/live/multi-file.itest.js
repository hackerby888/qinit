// One file open is not the state a developer is in. `contractAnalysisContexts` is keyed per document,
// so diagnostics analyse each contract under its own identity — but `contractPrefixPath` and
// `contractCorePath` are single module globals (`extension.ts:20-21`) set by whichever contract was last
// regenerated, and `filterCompletions` walks the allowed-identifier set from that one global
// (`extension.ts:190-191`). Switching editor tabs fires no open event, so the global stays pointed at
// the file you left while you complete in the file you returned to.
//
// Two mitigations stand between that and a wrong answer: every contract's prefix walks the same QPI
// surface, and `documentIdentifiers(doc.getText())` keeps whatever the current buffer itself mentions.
// These cases measure what actually survives rather than assuming either way.
const assert = require("node:assert");
const { clangdRunning, open, completionLabels, resolvedMemberLabels, stableLabels, sleep } = require("../campaign-lib");

const METER = "contracts/Meter.h";
const FEED = "contracts/Feed.h";

/** A stable, comparable view of a completion list. */
const fingerprint = (labels) => [...new Set(labels)].sort();

// clangd decorates some labels with a leading bullet and varies which compiler builtins it volunteers
// between a cold and a warm index. Neither is the allowed-identifier set, so neither is the subject
// here: strip the decoration and drop the `_`-led builtins before comparing.
const qpiSurface = (labels) => fingerprint(labels.map((label) => label.replace(/^[^A-Za-z_]+/, "")).filter((label) => !label.startsWith("_")));

const diff = (a, b) => ({
    lost: a.filter((label) => !b.includes(label)),
    gained: b.filter((label) => !a.includes(label)),
});

suite("live — several contracts open at once", function () {
    this.timeout(240000);

    suiteSetup(async () => {
        await open(METER);
        await clangdRunning({ timeout: 90000 });
    });

    // The measurement: the same receiver in the same file, once with its own contract last regenerated
    // and once with a sibling's. Any difference is the global leaking into a file it does not describe.
    test("a member list does not change because another contract was opened", async () => {
        const meter = await open(METER);
        const first = await resolvedMemberLabels(meter, "locals.scratch.tick", "locals.scratch.");
        assert.ok(first.settled, `baseline must resolve first, got [${first.labels.slice(0, 8).join(", ")}]`);
        const own = fingerprint(first.labels);
        console.log(`    Meter last regenerated -> ${own.length} items: ${own.join(", ")}`);

        // Opening Feed regenerates and repoints the global. Returning to Meter fires no open event.
        await open(FEED);
        await sleep(1500);
        await open(METER);
        const second = await resolvedMemberLabels(meter, "locals.scratch.tick", "locals.scratch.");
        const after = fingerprint(second.labels);
        console.log(`    Feed last regenerated  -> ${after.length} items: ${after.join(", ")}`);

        const { lost, gained } = diff(own, after);
        if (lost.length || gained.length) console.log(`      lost: [${lost.join(", ")}]  gained: [${gained.join(", ")}]`);
        assert.deepStrictEqual({ lost, gained }, { lost: [], gained: [] }, "the active contract decides its own member list");
    });

    // The identifier tier is the one the allow-set actually gates. The position matters: a receiver deep
    // in an expression answers with one or two items, which cannot tell a filtered list from an intact
    // one. A bare `B` at type position answers with tens of QPI names and is where a lost entry shows.
    test("an identifier list does not change because another contract was opened", async () => {
        const meter = await open(METER);
        const marker = "        BitArray<8> flags;";
        const upto = "        B";

        // clangd volunteers the odd system symbol inconsistently — `arc4random_buf`, `simde_bool` — and
        // that variance is its index, not the allowed-identifier set. Two readings in the *same* state
        // measure it, so the comparison across states can be restricted to names that are stable anyway:
        // lost is what both same-state readings agreed on and the other state lacks, and gained is what
        // the other state has and neither same-state reading ever produced.
        const first = qpiSurface((await stableLabels(meter, marker, upto)).labels);
        const second = qpiSurface((await stableLabels(meter, marker, upto)).labels);
        const stable = first.filter((name) => second.includes(name));
        const everSeen = new Set([...first, ...second]);
        console.log(`    Meter last regenerated -> ${first.length}/${second.length} names, ${stable.length} stable across two readings`);
        assert.ok(stable.length > 20, `the probe must be able to see a difference; only ${stable.length} stable names`);

        await open(FEED);
        await sleep(1500);
        await open(METER);
        const after = qpiSurface((await stableLabels(meter, marker, upto)).labels);
        console.log(`    Feed last regenerated  -> ${after.length} names`);

        const lost = stable.filter((name) => !after.includes(name));
        const gained = after.filter((name) => !everSeen.has(name));
        console.log(`      lost: [${lost.slice(0, 12).join(", ")}]  gained: [${gained.slice(0, 12).join(", ")}]`);

        // What the allowed set does is a property of the walk, and it is asserted where it can be
        // measured exactly — "sibling contracts of one project walk to the same allowed set" in
        // completion-filter.test.ts, which compares the two sets name by name and finds them identical.
        // Through clangd the same question also measures its index, which volunteers and withholds
        // system symbols between requests on a period longer than a couple of samples: two rounds read
        // that noise as a lost name. So the counts are printed here for drift, and the assertion is kept
        // to the one thing clangd's variance cannot manufacture — a sibling's own names appearing.
        const foreign = gained.filter((label) => /^(Reading|Poll|Bump|Meter|Sample)/.test(label));
        assert.deepStrictEqual(foreign, [], `a sibling's own names must not appear: [${gained.join(", ")}]`);
    });

    // The reverse direction, which the document-identifier fallback cannot rescue: completing in Feed
    // while Meter's prefix is the live one. Meter's own types are not Feed's to offer.
    test("a sibling's types are not offered in a contract that cannot reach them", async () => {
        await open(METER);
        await sleep(1000);
        const feed = await open(FEED);
        await sleep(1500);
        // Re-point the global at Meter without re-opening Feed afterwards.
        await open(METER);
        await sleep(1500);

        const labels = qpiSurface(
            (await stableLabels(feed, "output.sample = state.get().recent.get(input.index);", "output.sample = state.get().rec", { minimum: 1 })).labels,
        );
        const foreign = labels.filter((label) => /^(Reading|Poll|Bump|Meter)/.test(label));
        console.log(`    Feed with Meter's prefix live -> ${labels.length} items`);
        console.log(`      Meter-only names offered: [${foreign.join(", ") || "none"}]`);
        assert.deepStrictEqual(foreign, [], "Feed does not call Meter, so Meter's names are not its surface");
    });

    // Completion is expected warm and fast; the existing suite budgets 500 ms on one small file. With
    // several contracts open the allow-set walk runs against whichever prefix is live.
    test("completion stays inside its budget with several contracts open", async () => {
        await open(FEED);
        const meter = await open(METER);
        await clangdRunning({ timeout: 90000 });
        await completionLabels(meter, "locals.scratch.tick", "locals.scratch.");

        const timings = [];
        for (let i = 0; i < 5; i++) {
            const started = Date.now();
            await completionLabels(meter, "locals.scratch.tick", "locals.scratch.");
            timings.push(Date.now() - started);
        }
        const worst = Math.max(...timings);
        console.log(`    warm completion with 2 contracts open -> ${timings.join(", ")} ms (worst ${worst})`);
        assert.ok(worst < 500, `warm completion should stay under 500 ms, worst was ${worst} ms`);
    });
});
