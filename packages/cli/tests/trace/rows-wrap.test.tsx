import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render, Text } from "ink";
import { LabelRow } from "../../src/trace/views";

const LABEL_WIDTH = 6;
const COLUMNS = 40;
// wrap-ansi keeps leading spaces, so a space-free value is what proves the indent comes from the layout.
const LONG_VALUE = "A".repeat(60);

function renderLines(wrap: "wrap" | "truncate-end"): string[] {
    const frames: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
        columns: COLUMNS,
        rows: 24,
        write: (frame: string) => {
            frames.push(frame);
            return true;
        },
    });

    const instance = render(
        <LabelRow label={<Text>caller</Text>} labelWidth={LABEL_WIDTH} wrap={wrap}>
            {LONG_VALUE}
        </LabelRow>,
        { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false },
    );
    instance.unmount();

    // under CI ink closes with a bare newline on unmount, so the frame is the last write that drew anything.
    const drawn = frames.map((frame) => stripVTControlCharacters(frame)).filter((frame) => frame.trim().length > 0);

    return (drawn[drawn.length - 1] ?? "").split("\n").filter((line) => line.length > 0);
}

describe("trace label rows", () => {
    test("a wrapped value continues under the value column", () => {
        const lines = renderLines("wrap");

        expect(lines.length).toBeGreaterThan(1);
        expect(lines[0].startsWith("caller ")).toBe(true);
        for (const line of lines.slice(1)) {
            expect(line.startsWith(" ".repeat(LABEL_WIDTH + 1))).toBe(true);
            expect(line.trim().length).toBeGreaterThan(0);
        }
        expect(lines.map((line) => line.slice(LABEL_WIDTH + 1).trim()).join("")).toBe(LONG_VALUE);
    });

    test("truncate mode keeps the row on one line", () => {
        const lines = renderLines("truncate-end");

        expect(lines.length).toBe(1);
        expect(lines[0].length).toBeLessThanOrEqual(COLUMNS);
    });
});
