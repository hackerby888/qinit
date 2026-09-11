// A canary for the heuristic in `memberCompletions`, which treats a list as unresolved only when it is
// empty or entirely `Text`-kind. That held when measured: a healthy receiver answers Field/Method, and a
// degraded one answered `Text=98` — wholly Text, so the fallback fired. If clangd ever starts returning a
// *mixed* degraded list, the heuristic silently stops firing and this test is what shows it.
const assert = require("node:assert");
const vscode = require("vscode");
const { clangdRunning, open, settledLabels, completionItems, labelOf } = require("../campaign-lib");

const DESK = "contracts/Desk.h";

const KIND_NAMES = Object.fromEntries(
    Object.entries(vscode.CompletionItemKind)
        .filter(([, value]) => typeof value === "number")
        .map(([name, value]) => [value, name]),
);

function histogram(items) {
    const counts = new Map();
    for (const item of items) {
        const name = item.kind === undefined ? "undefined" : (KIND_NAMES[item.kind] ?? String(item.kind));
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

suite("campaign — completion item kinds", function () {
    this.timeout(180000);

    test("kind histogram at a healthy and a degraded receiver", async () => {
        const doc = await open(DESK);
        await clangdRunning({ timeout: 90000 });
        await settledLabels(doc, "locals.input.history.setAll", "locals.input.history.", "setAll", { timeout: 90000 });

        for (const [label, marker, dot] of [
            ["locals.input.history.", "locals.input.history.setAll", "locals.input.history."],
            ["locals.input.", "locals.input.history.setAll", "locals.input."],
            ["state.get().", "state.get().calls;", "state.get()."],
            ["locals.input.detail.", "locals.input.detail.rank", "locals.input.detail."],
            ["locals.input.detail.bits.", "locals.input.detail.bits.setAll", "locals.input.detail.bits."],
        ]) {
            const items = await completionItems(doc, marker, dot);
            console.log(`    ${label.padEnd(36)} ${items.length} items`);
            console.log(
                `      kinds: ${histogram(items)
                    .map(([k, n]) => `${k}=${n}`)
                    .join(", ")}`,
            );
            console.log(
                `      first: ${items
                    .slice(0, 6)
                    .map((i) => `${labelOf(i)}:${KIND_NAMES[i.kind] ?? "undefined"}`)
                    .join(", ")}`,
            );
            // Either a real member list, or one the heuristic can still recognise as degraded.
            const kinds = new Set(items.map((item) => item.kind));
            const allText = items.every((item) => item.kind === undefined || item.kind === vscode.CompletionItemKind.Text);
            assert.ok(
                items.length === 0 || allText || !kinds.has(vscode.CompletionItemKind.Text),
                `${label}: a mixed list would slip past the unresolved check — ${items.length} items, kinds ${[...kinds].map((k) => KIND_NAMES[k] ?? k).join("/")}`,
            );
        }
    });
});
