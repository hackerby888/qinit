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

/** Hover text at the first occurrence of `marker`, flattened to one string. */
async function hoverAt(doc, marker, offsetInto = 0) {
    const offset = doc.getText().indexOf(marker);
    assert.ok(offset >= 0, `missing hover marker ${marker}`);
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, doc.positionAt(offset + offsetInto));
    return (hovers || []).flatMap((hover) => hover.contents.map((content) => (typeof content === "string" ? content : content.value))).join("\n");
}

/** Only the extension's own IDL hover, ignoring whatever clangd contributes at the same position. */
async function idlHoverAt(doc, marker, offsetInto = 0) {
    const text = await hoverAt(doc, marker, offsetInto);
    return text
        .split("\n")
        .filter((line) => /QPI (function|procedure)|index \*\*|input  :|output :/.test(line))
        .join("\n");
}

// A word-scrape carries whatever is in the buffer, keywords included; a resolved member list is the
// receiver's fields and nothing else. Kind alone does not separate them — clangd sometimes returns the
// scrape with real kinds attached — but a member list never contains `struct` or `namespace`.
const SCRAPE_ONLY = ["struct", "namespace", "using", "public", "class"];

/**
 * Member labels, settled on a list that is actually resolved rather than one that merely contains the
 * word being waited for. clangd's degraded answer holds every identifier in the file, including that
 * one, so waiting on the name alone silently accepts the scrape and compares noise against noise.
 */
async function resolvedMemberLabels(doc, marker, dot, opts) {
    const result = await settle(
        () => completionItems(doc, marker, dot),
        (items) => {
            if (!items.length) return false;
            const labels = items.map(labelOf);
            return !SCRAPE_ONLY.some((keyword) => labels.includes(keyword));
        },
        { timeout: 30000, ...opts },
    );
    return { settled: result.settled, ms: result.ms, labels: result.value.map(labelOf) };
}

/**
 * The names a position offers consistently. clangd volunteers the odd extra symbol between a cold and a
 * warm index, and a request made too soon after switching documents comes back nearly empty — so each
 * sample is first settled to a warm one, and only the intersection of several is reported.
 */
async function stableLabels(doc, marker, upto, { samples = 3, minimum = 20, timeout = 20000 } = {}) {
    let common = null;
    let warm = 0;
    for (let i = 0; i < samples; i++) {
        const settled = await settle(
            () => completionLabels(doc, marker, upto),
            (labels) => labels.length >= minimum,
            { timeout, interval: 300 },
        );
        if (!settled.settled) continue;
        warm++;
        const labels = new Set(settled.value);
        common = common === null ? labels : new Set([...common].filter((label) => labels.has(label)));
        await sleep(150);
    }
    return { labels: [...(common ?? [])].sort(), warm };
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
    hoverAt,
    idlHoverAt,
    resolvedMemberLabels,
    stableLabels,
};
