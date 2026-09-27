import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { CallFooter } from "../../src/commands/deploy-interact/call";

const ADDRESS = "EBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGRAM";
const TX = "a".repeat(60);

function renderLines(props: { address?: string; balance?: string; tx?: string }): string[] {
    const frames: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
        columns: 100,
        rows: 24,
        write: (frame: string) => {
            frames.push(frame);
            return true;
        },
    });

    const instance = render(<CallFooter {...props} />, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        debug: true,
        patchConsole: false,
        exitOnCtrlC: false,
    });
    instance.unmount();

    // under CI ink closes with a bare newline on unmount, so the frame is the last write that drew anything.
    const drawn = frames.map((frame) => stripVTControlCharacters(frame)).filter((frame) => frame.trim().length > 0);

    return (drawn[drawn.length - 1] ?? "")
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
}

describe("call footer", () => {
    test("the contract rows sit under their own heading and the explorer hint closes the output", () => {
        const lines = renderLines({ address: ADDRESS, balance: "2250", tx: TX });

        const heading = lines.findIndex((line) => line.includes("CONTRACT"));
        expect(heading).toBeGreaterThanOrEqual(0);
        expect(lines[heading]).toContain("─");
        expect(lines[heading + 1]).toBe("  SC balance 2250");
        expect(lines[heading + 2]).toBe(`  SC address ${ADDRESS}`);
        expect(lines[lines.length - 1]).toBe(`qinit explorer ${TX} for more info`);
    });

    test("a call without a transaction prints no explorer hint", () => {
        const lines = renderLines({ address: ADDRESS, balance: "2250" });

        expect(lines.some((line) => line.includes("SC address"))).toBe(true);
        expect(lines.some((line) => line.includes("qinit explorer"))).toBe(false);
    });

    test("a call that read no contract info prints no contract section", () => {
        const lines = renderLines({ tx: TX });

        expect(lines).toEqual([`qinit explorer ${TX} for more info`]);
    });
});
