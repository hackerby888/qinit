// A file-size ratchet for every package. packages/compiler enforces its own cap in its architecture test;
// the files that actually run long live outside it, so this gate covers the whole workspace.
//
// New files must come in under MAX_FILE_LINES. The oversized files that predate this gate are listed in
// BUDGETS at the size they had when it landed, so they can shrink but never grow. Lower a budget whenever
// a split lands; delete the entry once the file is under the cap.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const MAX_FILE_LINES = 700;

const BUDGETS: Record<string, number> = {
    "packages/engine/src/contract/runtime.ts": 1231,
    "packages/engine/src/ledger/assets.ts": 1229,
    "packages/engine/src/qubic-simulator.ts": 1516,
    "packages/engine/src/transport.ts": 844,
    "packages/proto/src/abi-fmt.ts": 838,
};

function sourceFiles(): string[] {
    const pattern = new Bun.Glob("packages/*/src/**/*.{ts,tsx}");

    return [...pattern.scanSync({ cwd: root })]
        .map((path) => path.replaceAll("\\", "/"))
        .filter((path) => !/(^|\/)(node_modules|dist|generated|\.generated)\//.test(path))
        .sort();
}

test("no source file grows past its size budget", () => {
    const offenders: string[] = [];

    for (const path of sourceFiles()) {
        const lines = readFileSync(resolve(root, path), "utf8").split("\n").length;
        const budget = BUDGETS[path] ?? MAX_FILE_LINES;

        if (lines > budget) {
            const why = BUDGETS[path] ? "over its recorded budget" : `over the ${MAX_FILE_LINES}-line cap`;
            offenders.push(`${path}: ${lines} lines, ${why} (${budget})`);
        }
    }

    expect(offenders).toEqual([]);
});

// A budget that no longer binds is stale bookkeeping, and it would silently re-grant headroom a split
// already gave back.
test("size budgets stay tight against the files they cover", () => {
    const stale: string[] = [];

    for (const [path, budget] of Object.entries(BUDGETS)) {
        const lines = readFileSync(resolve(root, path), "utf8").split("\n").length;

        if (lines <= MAX_FILE_LINES) {
            stale.push(`${path}: ${lines} lines is under the cap — drop its budget`);
        } else if (lines < budget) {
            stale.push(`${path}: ${lines} lines — lower its budget from ${budget}`);
        }
    }

    expect(stale).toEqual([]);
});
