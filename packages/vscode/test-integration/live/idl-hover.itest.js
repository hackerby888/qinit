// The IDL hover is where a developer reads the index and payload for a call, so a wrong answer becomes a
// wrong transaction. It matches the bare word under the cursor against the edited file's own IDL.
const assert = require("node:assert");
const { clangdRunning, open, replaceDocument, idlHoverAt, sleep } = require("../campaign-lib");

const METER = "contracts/Meter.h";

suite("live — the IDL hover", function () {
    this.timeout(240000);

    let pristine;

    suiteSetup(async () => {
        pristine = (await open(METER)).getText();
        await clangdRunning({ timeout: 90000 });
    });

    teardown(async () => {
        const doc = await open(METER);
        await replaceDocument(doc, pristine);
        await doc.save();
        await sleep(300);
    });

    test("an entry of this contract hovers with its own index and payload", async () => {
        const doc = await open(METER);
        const poll = await idlHoverAt(doc, "PUBLIC_FUNCTION_WITH_LOCALS(Poll)", "PUBLIC_FUNCTION_WITH_LOCALS(".length);
        const bump = await idlHoverAt(doc, "PUBLIC_PROCEDURE(Bump)", "PUBLIC_PROCEDURE(".length);
        console.log(`    Poll -> ${poll.replace(/\n/g, " | ") || "(no hover)"}`);
        console.log(`    Bump -> ${bump.replace(/\n/g, " | ") || "(no hover)"}`);
        assert.match(poll, /QPI function/, "Poll is a registered function");
        assert.match(poll, /index \*\*1\*\*/, "Poll is registered at index 1");
        assert.match(bump, /QPI procedure/, "Bump is a registered procedure");
        assert.match(bump, /index \*\*2\*\*/, "Bump is registered at index 2");
    });

    // A procedure has an output struct exactly as a function does, and `hoverFor` prints the output line
    // only for functions. If a procedure's output carries fields, the hover is hiding half the payload.
    test("a procedure's output is not hidden", async () => {
        const doc = await open(METER);
        await replaceDocument(doc, pristine.replace("struct Bump_output\n    {\n    };", "struct Bump_output\n    {\n        uint64 total;\n    };"));
        await doc.save();
        await sleep(600);
        const bump = await idlHoverAt(doc, "PUBLIC_PROCEDURE(Bump)", "PUBLIC_PROCEDURE(".length);
        console.log(`    Bump with a non-empty output -> ${bump.replace(/\n/g, " | ") || "(no hover)"}`);
        assert.match(bump, /output/, "a procedure that returns fields must show them");
    });

    // The headline: `Read` in Meter names *Feed's* function, reached through CALL_OTHER_CONTRACT_FUNCTION. If
    // Meter registers its own Read, the developer hovering the call site is shown Meter's index.
    test("a callee's entry does not borrow this contract's index", async () => {
        const doc = await open(METER);
        const withCollision = pristine
            .replace(
                "    struct Bump_input\n    {\n    };",
                "    struct Read_input\n    {\n    };\n    struct Read_output\n    {\n    };\n\n    PUBLIC_PROCEDURE(Read)\n    {\n        state.mut().calls += 1;\n    }\n\n    struct Bump_input\n    {\n    };",
            )
            .replace("        REGISTER_USER_PROCEDURE(Bump, 2);", "        REGISTER_USER_PROCEDURE(Bump, 2);\n        REGISTER_USER_PROCEDURE(Read, 3);");
        await replaceDocument(doc, withCollision);
        await doc.save();
        await sleep(800);

        // Meter's own Read is a procedure at index 3; Feed's Read is a function at index 1.
        const own = await idlHoverAt(doc, "PUBLIC_PROCEDURE(Read)", "PUBLIC_PROCEDURE(".length);
        const atCallSite = await idlHoverAt(doc, "CALL_OTHER_CONTRACT_FUNCTION(Feed, Read", "CALL_OTHER_CONTRACT_FUNCTION(Feed, ".length);
        console.log(`    Meter's own Read      -> ${own.replace(/\n/g, " | ") || "(no hover)"}`);
        console.log(`    Read at the call site -> ${atCallSite.replace(/\n/g, " | ") || "(no hover)"}`);

        assert.match(own, /index \*\*3\*\*/, "Meter's own Read is registered at index 3");
        // Feed::Read is a function at index 1. Showing Meter's procedure at index 3 here would hand the
        // developer the wrong index for the call they are actually looking at.
        assert.ok(
            !/QPI procedure/.test(atCallSite) && !/index \*\*3\*\*/.test(atCallSite),
            `the call site names Feed's Read, not Meter's — got: ${atCallSite.replace(/\n/g, " | ") || "(no hover)"}`,
        );
    });

    // The bare-name match reaches words that are not code at all.
    test("an entry name written in prose is not given an IDL hover", async () => {
        const doc = await open(METER);
        await replaceDocument(doc, pristine.replace("    struct Reading\n    {", "    // Poll is mentioned here in prose.\n    struct Reading\n    {"));
        await doc.save();
        await sleep(800);

        const inComment = await idlHoverAt(doc, "// Poll is mentioned here in prose.", "// ".length);
        console.log(`    'Poll' inside a comment -> ${inComment.replace(/\n/g, " | ") || "(no hover)"}`);
        assert.strictEqual(inComment, "", "prose is not an entry reference");
    });

    // E14, pinned failing: a field sharing an entry's name is a real identifier token, so the token pass cannot
    // see the difference. Telling a declarator from a reference needs parse context the provider does not have.
    test("a struct field is not the procedure of the same name", async () => {
        const doc = await open(METER);
        await replaceDocument(
            doc,
            pristine.replace("        uint64 tick;\n        BitArray<8> flags;", "        uint64 tick;\n        uint64 Bump;\n        BitArray<8> flags;"),
        );
        await doc.save();
        await sleep(800);

        const asField = await idlHoverAt(doc, "uint64 Bump;", "uint64 ".length);
        console.log(`    a field named 'Bump' -> ${asField.replace(/\n/g, " | ") || "(no hover)"}`);
        assert.strictEqual(asField, "", "a struct field is not the procedure of the same name");
    });
});
