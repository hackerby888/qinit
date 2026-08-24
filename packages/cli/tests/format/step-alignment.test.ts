import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { STEP_LABEL_PAD } from "../../src/ui/feedback";

const CLI_SRC = resolve(import.meta.dir, "..", "..", "src");

// Step and StepRow lay their detail out at a fixed column, so a label that reaches the pad leaves no
// gutter and runs into its detail. Every list that feeds them is checked here rather than by eye,
// because the failure only shows up in a rendered frame.
const STEP_LABEL_SOURCES = [
    "commands/node/node-run.tsx",
    "commands/develop/integrate.tsx",
    "commands/setup/setup.tsx",
    "ops/deploy/steps.ts",
];

function labelsIn(relativePath: string): string[] {
    const source = readFileSync(join(CLI_SRC, relativePath), "utf8");
    return [...source.matchAll(/\blabel:\s*"([^"]+)"/g)].map((match) => match[1]);
}

describe("step rows keep a gutter between label and detail", () => {
    for (const relativePath of STEP_LABEL_SOURCES) {
        test(`${relativePath} labels fit the shared column`, () => {
            const labels = labelsIn(relativePath);

            expect(labels.length).toBeGreaterThan(0);
            const tooWide = labels.filter((label) => label.length + 2 > STEP_LABEL_PAD);
            expect(tooWide).toEqual([]);
        });
    }

    // A pad that merely equals the longest label produces `check contractok`, which is what this guards.
    test("the pad leaves room for the widest label plus a gutter", () => {
        const widest = Math.max(...STEP_LABEL_SOURCES.flatMap(labelsIn).map((label) => label.length));

        expect(STEP_LABEL_PAD).toBeGreaterThanOrEqual(widest + 2);
    });
});
