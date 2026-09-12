// The allowed-identifier set decides what a contract developer is allowed to see, and three of its
// rules had never been exercised against a real editor:
//
//   `_`-led members  — `keepMemberLabel` hides them until the developer types a leading `_`, and hides
//                      `__` names always (`completion-filter.ts:140-150`). `id`'s `_0.._3` limbs are the
//                      case that matters: real members, worth completing, invisible by default.
//   the gtest path   — a test file is deliberately NOT narrowed to the QPI surface; only the member step
//                      applies, so `std::` and the gtest macros survive (`extension.ts:182-187`).
//   `CC_*`           — cheatcodes are whitelisted by pattern, unconditionally, because their header sits
//                      outside the include walk (`completion-filter.ts:14, 168-170`).
//
// Every probe writes the line it completes on into the buffer first. `completionItems` moves the cursor
// by an offset from a marker; it cannot type, so completing "after `std::`" needs a `std::` really there.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, open, replaceDocument, completionLabels, resolvedMemberLabels, settle, sleep } = require("../campaign-lib");

const DESK = "contracts/Desk.h";
const DESK_TEST = "Desk.test.cpp";
const ANCHOR = "        locals.input.offset = 0;";

// clangd decorates some labels with a leading bullet, and `executeCompletionItemProvider` aggregates
// every provider — including VS Code's built-in word-based one, which offers the prose in the file's
// comments and is nothing to do with this extension's filter. Both have to be accounted for.
const bare = (label) => label.trim().replace(/^[^A-Za-z_]+/, "");
const has = (labels, name) => labels.some((label) => bare(label) === name || bare(label).startsWith(`${name}(`));

suite("campaign — the allowed-identifier set", function () {
    this.timeout(240000);

    let pristine;

    suiteSetup(async () => {
        pristine = (await open(DESK)).getText();
        await clangdRunning({ timeout: 90000 });
    });

    teardown(async () => {
        const doc = await open(DESK);
        await replaceDocument(doc, pristine);
        await doc.save();
        await sleep(400);
    });

    /** Writes `line` into the Read body and returns the document, so a probe can complete on real text. */
    async function withLine(line) {
        const doc = await open(DESK);
        await replaceDocument(doc, pristine.replace(ANCHOR, `${ANCHOR}\n${line}`));
        await sleep(700);
        return doc;
    }

    // A log struct's `_type` is the rule's own documented case: a real member, worth completing, hidden
    // until the developer types the underscore. The buffer has to contain `locals.note._type` for that —
    // `completionItems` advances a cursor, it does not type, so completing "after the underscore" against
    // a buffer holding `locals.note.amount` lands inside `amount` and measures the prefix `a`.
    //
    // (`id` is not the vehicle here: on this core `m256i` exposes MSVC intrinsic aliases rather than
    // QPI's `_0.._3`, as round 3 already measured.)
    test("a `_`-led member is hidden until the underscore is typed", async () => {
        const doc = await open(DESK);
        const withLog = pristine
            .replace(
                "    struct Read_locals\n    {",
                "    struct Noted\n    {\n        uint64 amount;\n        uint8 _type;\n    };\n\n    struct Read_locals\n    {\n        Noted note;",
            )
            .replace(ANCHOR, `${ANCHOR}\n        locals.note._type = 0;`);
        await replaceDocument(doc, withLog);
        await sleep(900);

        const plain = await resolvedMemberLabels(doc, "locals.note._type", "locals.note.");
        console.log(`    locals.note.  -> ${plain.labels.length} items: ${plain.labels.slice(0, 8).join(", ")}`);
        const underscored = await completionLabels(doc, "locals.note._type", "locals.note._");
        console.log(`    locals.note._ -> ${underscored.length} items: ${underscored.slice(0, 8).join(", ")}`);

        assert.ok(has(plain.labels, "amount"), `the plain member must be offered: [${plain.labels.slice(0, 8).join(", ")}]`);
        assert.ok(!has(plain.labels, "_type"), `a bare receiver must hide the \`_\`-led member: [${plain.labels.slice(0, 8).join(", ")}]`);
        assert.ok(has(underscored, "_type"), `typing the underscore must reveal it: [${underscored.slice(0, 8).join(", ")}]`);

        const reserved = [...plain.labels, ...underscored].filter((label) => bare(label).startsWith("__"));
        assert.deepStrictEqual(reserved, [], "`__` names are reserved and never offered");
    });

    // Operators and destructors come with every struct and none can be written after a dot in QPI.
    test("a member list carries no operator or destructor", async () => {
        const doc = await open(DESK);
        const members = await resolvedMemberLabels(doc, "locals.input.history.setAll", "locals.input.history.");
        assert.ok(members.settled, "the container receiver must resolve");
        const noise = members.labels.filter((label) => /^(operator\b|~)/.test(label.trim()));
        console.log(`    locals.input.history. -> ${members.labels.length} items, ${noise.length} operator/dtor`);
        assert.deepStrictEqual(noise, [], `a member list drops operators and destructors: [${noise.join(", ")}]`);
    });

    // The narrowing exists to remove exactly this from a contract.
    test("std:: is blocked inside a contract", async () => {
        const doc = await withLine("        std::");
        const labels = await completionLabels(doc, "        std::", "        std::".length);
        const library = labels.filter((label) => ["vector", "string", "map", "size_t", "cout", "unique_ptr", "sort"].includes(bare(label)));
        console.log(`    'std::' in a contract -> ${labels.length} items, ${library.length} from the C++ library`);
        console.log(`      (the rest is VS Code's own word-based provider, which no extension filter governs)`);
        assert.deepStrictEqual(library, [], `std:: is not the QPI surface: [${library.join(", ")}]`);
    });

    // `CC_*` is whitelisted by pattern with no check of its own, so what keeps a production contract
    // clean is the prefix header: Desk's declares fourteen cheatcodes, and offering them is correct.
    // The unit suite covers the production wrapper, which declares none.
    test("cheatcodes the prefix declares are offered", async () => {
        const doc = await withLine("        CC_");
        const labels = await completionLabels(doc, "        CC_", "        CC_".length);
        const cheats = labels.filter((label) => /^CC_/.test(bare(label)));
        console.log(`    'CC_' in a cheat-enabled contract -> ${labels.length} items, ${cheats.length} cheat names`);
        console.log(`      offered: ${cheats.slice(0, 6).map(bare).join(", ")}`);
        assert.ok(cheats.length > 0, "the prefix declares cheatcodes, so they must complete");
    });

    // A gtest is not a contract: narrowing it to the QPI surface would hide the library it is written in.
    test("a gtest keeps std:: and the gtest macros", async () => {
        const doc = await open(DESK_TEST);
        await clangdRunning({ timeout: 90000 });

        const macros = await settle(
            () => completionLabels(doc, "TEST(ContractDesk, Read)", 2),
            (labels) => has(labels, "TEST"),
            { timeout: 30000 },
        );
        console.log(`    'TE' in the gtest -> ${macros.value.length} items: ${macros.value.slice(0, 10).join(", ")}`);
        assert.ok(macros.settled, `the gtest macros must survive: [${macros.value.slice(0, 12).join(", ")}]`);

        const stdScope = await settle(
            () => completionLabels(doc, "ContractTestingDesk test;", "ContractTestingDesk".length),
            (labels) => labels.length > 0,
            { timeout: 20000 },
        );
        console.log(`    a gtest identifier position -> ${stdScope.value.length} items, std present: ${has(stdScope.value, "std")}`);
        assert.ok(stdScope.value.length > 0, "a gtest is not narrowed, so its identifier list stays populated");
    });
});
