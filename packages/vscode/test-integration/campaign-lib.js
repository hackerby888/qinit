// Campaign helpers: everything the editor suite needs to wait on a real signal instead of a fixed sleep.
const assert = require("node:assert");
const fs = require("node:fs");
const vscode = require("vscode");

const CLANGD_ID = "llvm-vs-code-extensions.vscode-clangd";
const CLANGD_RUNNING = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `.exports` is a getter that THROWS for a known-but-not-yet-activated extension, so `?.` is no guard:
// isActive has to be checked first.
function clangdClient() {
    const extension = vscode.extensions.getExtension(CLANGD_ID);
    if (!extension?.isActive) return undefined;
    return extension.exports?.getApi?.(1)?.languageClient;
}

/** Resolves once the clangd client reports Running and still reports it after the extension's own grace. */
async function clangdRunning({ timeout = 60000, grace = 1500 } = {}) {
    await vscode.extensions.getExtension(CLANGD_ID)?.activate();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (clangdClient()?.state === CLANGD_RUNNING) {
            await sleep(grace);
            if (clangdClient()?.state === CLANGD_RUNNING) return true;
        }
        await sleep(250);
    }
    return false;
}

/** Polls `produce` until `ok` accepts its value. Returns {value, ms, attempts, settled} — never throws on timeout. */
async function settle(produce, ok, { timeout = 45000, interval = 500 } = {}) {
    const started = Date.now();
    let attempts = 0;
    let value;
    while (Date.now() - started < timeout) {
        attempts++;
        value = await produce();
        if (ok(value)) return { value, ms: Date.now() - started, attempts, settled: true };
        await sleep(interval);
    }
    return { value, ms: Date.now() - started, attempts, settled: false };
}

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

const labelOf = (item) => (typeof item.label === "string" ? item.label : item.label.label).trim();

/** Completion items at the first occurrence of `marker`, with the cursor placed after `dot`. */
async function completionItems(doc, marker, dot) {
    const offset = doc.getText().indexOf(marker);
    assert.ok(offset >= 0, `missing completion marker ${marker}`);
    const pos = doc.positionAt(offset + dot.length);
    const list = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", doc.uri, pos);
    return list?.items ?? [];
}

async function completionLabels(doc, marker, dot) {
    return (await completionItems(doc, marker, dot)).map(labelOf);
}

/** Completion labels, retried until `wanted` appears — the honest form of "wait for the list". */
async function settledLabels(doc, marker, dot, wanted, opts) {
    // The name exactly, or the same name as a call: clangd's method labels carry a signature, while a
    // bare `startsWith` would let a one-letter field like `a` match a word in a degraded word-scrape list.
    return settle(
        () => completionLabels(doc, marker, dot),
        (labels) => labels.some((l) => l === wanted || l.startsWith(`${wanted}(`)),
        opts,
    );
}

function compileEntries() {
    return JSON.parse(fs.readFileSync(wsUri("compile_commands.json").fsPath, "utf8"));
}

function diagnosticsFor(doc, sources) {
    return vscode.languages.getDiagnostics(doc.uri).filter((d) => !sources || sources.includes(String(d.source)));
}

module.exports = {
    CLANGD_ID,
    CLANGD_RUNNING,
    sleep,
    clangdClient,
    clangdRunning,
    settle,
    wsUri,
    open,
    replaceDocument,
    labelOf,
    completionItems,
    completionLabels,
    settledLabels,
    compileEntries,
    diagnosticsFor,
};
