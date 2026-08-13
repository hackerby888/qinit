const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const vscode = require("vscode");

const EXT_ID = "qinit.qpi-vscode";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsUri(name) {
    return vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name);
}
async function open(name) {
    const doc = await vscode.workspace.openTextDocument(wsUri(name));
    await vscode.window.showTextDocument(doc);
    return doc;
}
async function replaceDocument(doc, source) {
    const edit = new vscode.WorkspaceEdit();
    const end = doc.positionAt(doc.getText().length);
    edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), end), source);
    assert.ok(await vscode.workspace.applyEdit(edit), `failed to edit ${doc.fileName}`);
}
async function hoverText(doc, marker) {
    const offset = doc.getText().indexOf(marker);
    assert.ok(offset >= 0, `missing hover marker ${marker}`);
    const pos = doc.positionAt(offset);
    const hovers = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        doc.uri,
        pos,
    );
    return (hovers || [])
        .flatMap((hover) =>
            hover.contents.map((content) =>
                typeof content === "string" ? content : content.value,
            ),
        )
        .join("\n");
}
// The member fallback shells out to clang++ (WASM_CLANG or PATH); without one it stays disabled.
function fallbackClangAvailable() {
    for (const candidate of [process.env.WASM_CLANG, "clang++"]) {
        if (!candidate) continue;
        try {
            execFileSync(candidate, ["--version"], { stdio: "pipe" });
            return true;
        } catch {}
    }
    return false;
}
async function completionItems(doc, marker, dot) {
    const offset = doc.getText().indexOf(marker);
    assert.ok(offset >= 0, `missing completion marker ${marker}`);
    const pos = doc.positionAt(offset + dot.length);
    const list = await vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        doc.uri,
        pos,
    );
    return list?.items ?? [];
}

const labelOf = (item) => (typeof item.label === "string" ? item.label : item.label.label).trim();

async function completionLabels(doc, marker, dot) {
    return (await completionItems(doc, marker, dot)).map(labelOf);
}

suite("Qubic QPI extension", function () {
    this.timeout(120000);

    test("activates with only the clangd maintenance command", async () => {
        const ext = vscode.extensions.getExtension(EXT_ID);
        assert.ok(ext, "extension is present");
        await ext.activate();
        const cmds = await vscode.commands.getCommands(true);
        assert.ok(
            cmds.includes("qpi.regenerateConfig"),
            "qpi.regenerateConfig should be registered",
        );
        for (const c of ["qpi.build", "qpi.deploy", "qpi.call", "qpi.gen", "qpi.test", "qpi.up"]) {
            assert.ok(
                !cmds.includes(c),
                `command ${c} should NOT be registered (removed for simplicity)`,
            );
        }
    });

    test("diagnostics fire on a violating contract", async () => {
        const doc = await open("Bad.h");
        await sleep(2500); // let onDidOpen -> refresh publish
        const diagnostics = vscode.languages.getDiagnostics(doc.uri);
        const codes = diagnostics.map((d) => String(d.code));
        assert.ok(
            codes.includes("qpi/no-division"),
            `expected qpi/no-division; got [${codes.join(", ")}]`,
        );
        assert.ok(
            codes.includes("qpi/no-brackets"),
            `expected qpi/no-brackets; got [${codes.join(", ")}]`,
        );
        assert.ok(
            diagnostics.some(
                (d) =>
                    String(d.source) === "qinit-compiler" && String(d.code) === "compiler/semantic",
            ),
            `expected a compiler semantic diagnostic; got [${codes.join(", ")}]`,
        );
    });

    test("a clean contract produces no extension diagnostics", async () => {
        const doc = await open("Counter.h");
        await sleep(2500);
        const diagnostics = vscode.languages.getDiagnostics(doc.uri);
        const extension = diagnostics.filter(
            (d) => String(d.source) === "qpi" || String(d.source) === "qinit-compiler",
        );
        const clang = diagnostics.filter((d) => String(d.source) === "clang");
        assert.strictEqual(
            extension.length,
            0,
            `clean contract should have no extension diagnostics; got ${extension.map((d) => d.code).join(", ")}`,
        );
        assert.strictEqual(
            clang.length,
            0,
            `clean contract should have no clang diagnostics; got ${clang.map((d) => d.code).join(", ")}`,
        );
    });

    test("configured Proxy resolves Counter without a node", async () => {
        const doc = await open("project/contracts/Proxy.h");
        await sleep(3000);

        // On a fresh profile clangd resolves the file before the database exists and reports undeclared
        // identifiers until the extension restarts it, so wait for that rather than sampling an instant.
        const contractErrors = () =>
            vscode.languages
                .getDiagnostics(doc.uri)
                .filter(
                    (diagnostic) =>
                        diagnostic.severity === vscode.DiagnosticSeverity.Error &&
                        ["qpi", "qinit-compiler", "qinit-project", "clang"].includes(
                            String(diagnostic.source),
                        ),
                );
        let errors = contractErrors();
        for (let attempt = 0; attempt < 20 && errors.length > 0; attempt++) {
            await sleep(1500);
            errors = contractErrors();
        }
        assert.strictEqual(
            errors.length,
            0,
            `Proxy should resolve Counter; got ${errors.map((d) => `${d.source}:${d.message}`).join(" | ")}`,
        );

        const clangdConfig = fs.readFileSync(wsUri(".clangd").fsPath, "utf8");
        const databaseMatch = /CompilationDatabase:\s*("[^"]+")/.exec(clangdConfig);
        assert.ok(databaseMatch, "generated .clangd should name its compilation database");
        const databaseDir = JSON.parse(databaseMatch[1]);
        const prefix = fs.readFileSync(`${databaseDir}/Proxy.prefix.h`, "utf8");
        assert.match(prefix, /#define CONTRACT_STATE_TYPE Counter/);
        assert.match(prefix, /#define CONTRACT_STATE_TYPE Proxy/);
        const counterSlot = Number(/#define Counter_CONTRACT_INDEX (\d+)/.exec(prefix)?.[1]);
        const proxySlots = [...prefix.matchAll(/#define CONTRACT_INDEX (\d+)/g)].map((match) =>
            Number(match[1]),
        );
        const proxySlot = proxySlots.at(-1);
        assert.ok(Number.isInteger(counterSlot), "Counter slot should be generated");
        assert.ok(Number.isInteger(proxySlot), "Proxy slot should be generated");
        assert.ok(counterSlot < proxySlot, "Counter must be below Proxy");
    });

    // clangd itself returns nothing for members reached through a field whose preamble type carries a
    // template member (upstream bug); the extension answers these through its clang fallback.
    test("cross-call callee members complete through the clang fallback", async function () {
        if (!fallbackClangAvailable()) this.skip();
        const doc = await open("project/contracts/Proxy.h");
        await sleep(3000);

        // The clangd client comes up asynchronously and the fallback builds a PCH on first use.
        let labels = [];
        for (let attempt = 0; attempt < 20; attempt++) {
            labels = await completionLabels(doc, "locals.input.offset", "locals.input.");
            if (labels.includes("offset")) break;
            await sleep(1500);
        }
        assert.ok(
            labels.includes("history") && labels.includes("offset"),
            `fallback should complete Get_input members; got [${labels.slice(0, 12).join(", ")}]`,
        );

        const arrayItems = await completionItems(
            doc,
            "locals.input.history.setAll",
            "locals.input.history.",
        );
        const arrayLabels = arrayItems.map(labelOf);
        assert.ok(
            arrayLabels.some((l) => l.startsWith("setAll")) &&
                arrayLabels.some((l) => l.startsWith("get")),
            `fallback should complete Array members; got [${arrayLabels.slice(0, 12).join(", ")}]`,
        );
        assert.ok(
            !arrayLabels.some(
                (l) => l.startsWith("operator") || l.startsWith("~") || l.startsWith("_"),
            ),
            `member lists carry no generated noise; got [${arrayLabels.slice(0, 12).join(", ")}]`,
        );

        // A method carries its parameters and return type, and inserts a snippet the way clangd's do.
        const setAll = arrayItems.find((item) => labelOf(item) === "setAll");
        assert.ok(setAll, `setAll should be offered; got [${arrayLabels.slice(0, 12).join(", ")}]`);
        assert.match(String(setAll.label.detail), /^\(.*value\)$/);
        assert.strictEqual(String(setAll.label.description), "void");
        assert.match(String(setAll.insertText?.value), /^setAll\(\$\{1:/);

        // Opening the callee regenerates its own prefix. The caller must keep completing afterwards,
        // and warm completions must stay far below a PCH rebuild (~700ms).
        await open("project/contracts/Counter.h");
        await sleep(2000);

        const started = Date.now();
        const afterCallee = await completionLabels(doc, "locals.input.offset", "locals.input.");
        const elapsedMs = Date.now() - started;
        console.log(`fallback completion after opening the callee: ${elapsedMs}ms`);

        assert.ok(
            afterCallee.includes("history") && afterCallee.includes("offset"),
            `caller should still complete after the callee opened; got [${afterCallee.slice(0, 8)}]`,
        );
        assert.ok(elapsedMs < 500, `warm completion should stay fast; took ${elapsedMs}ms`);
    });

    // A gtest compiles against its own generated prefix. Without one clangd falls back to plain flags
    // and every QPI symbol turns red, which is what an unconfigured test file used to look like.
    test("a gtest file is configured and completes callee members", async function () {
        if (!fallbackClangAvailable()) this.skip();
        const doc = await open("Counter.test.cpp");
        await sleep(3000);

        let errors = [];
        for (let attempt = 0; attempt < 20; attempt++) {
            errors = vscode.languages
                .getDiagnostics(doc.uri)
                .filter(
                    (diagnostic) =>
                        diagnostic.severity === vscode.DiagnosticSeverity.Error &&
                        String(diagnostic.source) === "clang",
                );
            if (errors.length === 0) break;
            await sleep(1500);
        }
        assert.strictEqual(
            errors.length,
            0,
            `gtest should compile against its prefix; got ${errors.map((d) => d.message).join(" | ")}`,
        );

        const clangdConfig = fs.readFileSync(wsUri(".clangd").fsPath, "utf8");
        const databaseDir = JSON.parse(/CompilationDatabase:\s*("[^"]+")/.exec(clangdConfig)[1]);
        const entries = JSON.parse(fs.readFileSync(`${databaseDir}/compile_commands.json`, "utf8"));
        assert.ok(
            entries.some((entry) => entry.file.endsWith("Counter.test.cpp")),
            "the test file should have its own compile entry",
        );

        // A gtest is not narrowed to the QPI surface, but its member lists lose the same noise.
        const members = await completionLabels(doc, "input.history.setAll", "input.history.");
        assert.ok(
            members.includes("setAll"),
            `a gtest should complete Array members; got [${members.slice(0, 12).join(", ")}]`,
        );
        assert.ok(
            !members.some(
                (l) => l.startsWith("operator") || l.startsWith("~") || l.startsWith("_"),
            ),
            `a gtest member list carries no generated noise; got [${members.slice(0, 12).join(", ")}]`,
        );
    });

    test("an ambiguous project callee is shown as a diagnostic", async () => {
        const duplicateDir = wsUri("project/contracts/duplicate").fsPath;
        const duplicate = `${duplicateDir}/Counter.h`;
        fs.mkdirSync(duplicateDir, { recursive: true });
        fs.copyFileSync(wsUri("project/contracts/Counter.h").fsPath, duplicate);

        try {
            const doc = await open("project/contracts/Proxy.h");
            await vscode.commands.executeCommand("qpi.regenerateConfig");
            await sleep(500);
            const diagnostic = vscode.languages
                .getDiagnostics(doc.uri)
                .find((item) => String(item.code) === "qinit/project-dependencies");
            assert.ok(diagnostic, "ambiguous Counter should produce a project diagnostic");
            assert.match(diagnostic.message, /Counter.*ambiguous/);
        } finally {
            fs.rmSync(duplicateDir, { recursive: true, force: true });
            await vscode.commands.executeCommand("qpi.regenerateConfig");
        }
    });

    test("plain C++ headers are ignored", async () => {
        const doc = await open("Plain.h");
        await sleep(1000);
        const qpi = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === "qpi");
        assert.strictEqual(qpi.length, 0, "plain C++ should not receive QPI diagnostics");
    });

    test("IDL hover shows the index + codec for a registered function", async () => {
        const doc = await open("Counter.h");
        const text = await hoverText(doc, "get) {");
        assert.ok(/QPI function/.test(text), `hover should name the QPI function; got: ${text}`);
        assert.match(text, /index \*\*1\*\*/);
        assert.match(text, /output\s*: uint64/);
    });

    test("IDL hover invalidates cached analysis after an edit", async () => {
        const doc = await open("Counter.h");
        const original = doc.getText();
        const changed = original.replace(
            "REGISTER_USER_FUNCTION(get, 1)",
            "REGISTER_USER_FUNCTION(get, 7)",
        );

        try {
            assert.notStrictEqual(changed, original, "registration marker should exist");
            assert.match(await hoverText(doc, "get) {"), /index \*\*1\*\*/);
            await replaceDocument(doc, changed);
            assert.match(await hoverText(doc, "get) {"), /index \*\*7\*\*/);

            await replaceDocument(doc, changed.replace(": public ContractBase", ""));
            assert.doesNotMatch(await hoverText(doc, "get) {"), /QPI function/);
        } finally {
            await replaceDocument(doc, original);
        }
    });

    test("editing a contract into a plain header clears stale diagnostics", async () => {
        const doc = await open("Bad.h");
        const original = doc.getText();

        try {
            await sleep(500);
            assert.ok(
                vscode.languages
                    .getDiagnostics(doc.uri)
                    .some((diagnostic) => String(diagnostic.code) === "qpi/no-division"),
                "contract should start with QPI diagnostics",
            );

            await replaceDocument(doc, original.replace(": public ContractBase", ""));
            await sleep(500);

            const stale = vscode.languages
                .getDiagnostics(doc.uri)
                .filter(
                    (diagnostic) =>
                        diagnostic.source === "qpi" || diagnostic.source === "qinit-compiler",
                );
            assert.strictEqual(
                stale.length,
                0,
                `plain header kept stale diagnostics: ${stale.map((d) => d.code).join(", ")}`,
            );
        } finally {
            await replaceDocument(doc, original);
        }
    });

    test("no QPI CodeLens buttons (removed for simplicity)", async () => {
        const doc = await open("Counter.h");
        const lenses = await vscode.commands.executeCommand(
            "vscode.executeCodeLensProvider",
            doc.uri,
        );
        const titles = (lenses || []).map((l) => (l.command && l.command.title) || "").join(" | ");
        assert.ok(
            !/build|deploy|call|gen client/i.test(titles),
            `expected no QPI action lenses; got: ${titles}`,
        );
    });

    test("standalone contract and test files receive a clangd database", async () => {
        await open("Counter.h");
        await open("Counter.test.cpp");
        await sleep(1500);

        const config = wsUri(".clangd").fsPath;
        assert.ok(fs.existsSync(config), ".clangd should be generated without qinit.json");
        const text = fs.readFileSync(config, "utf8");
        assert.match(text, /CompilationDatabase:/);
    });

    test("quick-fix offers Array<T, N> for a bracket violation", async () => {
        const doc = await open("Bad.h");
        await sleep(1500);
        const brackets = vscode.languages
            .getDiagnostics(doc.uri)
            .filter((d) => String(d.code) === "qpi/no-brackets");
        assert.ok(brackets.length, "should have a bracket diagnostic");
        const actions = await vscode.commands.executeCommand(
            "vscode.executeCodeActionProvider",
            doc.uri,
            brackets[0].range,
        );
        const titles = (actions || []).map((a) => a.title);
        assert.ok(
            titles.some((t) => /Array<T, N>/.test(t)),
            `expected the Array<T, N> quick-fix; got: ${titles.join(", ")}`,
        );
    });

    test("locals diagnostics fire; the qpi.h dev-include is exempt", async () => {
        const doc = await open("Locals.h");
        await sleep(2500);
        const diags = vscode.languages.getDiagnostics(doc.uri);
        const qpiCodes = diags.filter((d) => String(d.source) === "qpi").map((d) => String(d.code));
        assert.ok(
            qpiCodes.includes("qpi/stack-local"),
            `expected qpi/stack-local; got [${qpiCodes.join(", ")}]`,
        );
        assert.ok(
            qpiCodes.includes("qpi/needs-with-locals"),
            `expected qpi/needs-with-locals; got [${qpiCodes.join(", ")}]`,
        );
        const onInclude = diags.filter(
            (d) => String(d.source) === "qpi" && d.range.start.line === 2,
        );
        assert.strictEqual(
            onInclude.length,
            0,
            `qpi.h include should be exempt; got [${onInclude.map((d) => d.code).join(", ")}]`,
        );
    });
});
