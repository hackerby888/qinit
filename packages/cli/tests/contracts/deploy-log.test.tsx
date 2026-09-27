import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { DeployLog } from "../../src/commands/deploy-interact/deploy-log";
import { deploymentLog, type ContractStatus, type DeploymentNote } from "../../src/ops/deploy";

const contract = (name: string, slot: number, kind: ContractStatus["kind"], status: string, tone: ContractStatus["tone"], source?: string): DeploymentNote => ({
    note: `${kind} ${name} @ ${slot}: ${status}`,
    contract: { name, slot, kind, status, tone, source },
});

const NOTES: DeploymentNote[] = [
    contract("Counter2", 31, "main", "building", "active", "contracts/Counter2.h"),
    contract("QUTIL", 4, "system", "building (typescript)", "active"),
    contract("QX", 1, "system", "building (typescript)", "active"),
    contract("QX", 1, "system", "unchanged", "quiet", "contracts/system_scs/Qx.h"),
    contract("QUTIL", 4, "system", "unchanged", "quiet", "contracts/system_scs/QUtil.h"),
    { topic: "qinit.json", note: "system += QX, QUTIL" },
    { topic: "signer", note: "saved seed (qinit seed)" },
    { note: "⚠ version drift" },
    contract("Counter2", 31, "main", "deployed", "ok"),
];

function renderLines(notes: DeploymentNote[], limit?: number): string[] {
    const frames: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
        columns: 100,
        rows: 40,
        write: (frame: string) => {
            frames.push(frame);
            return true;
        },
    });

    const instance = render(<DeployLog notes={notes} limit={limit} />, {
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

describe("deploy log", () => {
    test("a contract keeps one row with its last status, systems first and Main last", () => {
        const log = deploymentLog(NOTES);

        expect(log.contracts.map(({ name, status, source }) => ({ name, status, source }))).toEqual([
            { name: "QX", status: "unchanged", source: "contracts/system_scs/Qx.h" },
            { name: "QUTIL", status: "unchanged", source: "contracts/system_scs/QUtil.h" },
            { name: "Counter2", status: "deployed", source: "contracts/Counter2.h" },
        ]);
        expect(log.lines).toEqual([
            { topic: "qinit.json", text: "system += QX, QUTIL" },
            { topic: "signer", text: "saved seed (qinit seed)" },
            { topic: undefined, text: "⚠ version drift" },
        ]);
    });

    test("the contracts are drawn as a table above the remarks, whose labels share a column", () => {
        const lines = renderLines(NOTES);

        const contracts = lines.findIndex((line) => line.includes("CONTRACTS"));
        const notes = lines.findIndex((line) => line.includes("NOTES"));
        expect(contracts).toBeGreaterThanOrEqual(0);
        expect(notes).toBeGreaterThan(contracts);
        expect(lines[contracts + 1].trim().split(/\s+/)).toEqual(["contract", "slot", "kind", "status", "source"]);
        expect(lines[contracts + 2].trim().split(/\s+/)).toEqual(["QX", "1", "system", "unchanged", "contracts/system_scs/Qx.h"]);
        expect(lines[contracts + 4].trim().split(/\s+/)).toEqual(["Counter2", "31", "main", "deployed", "contracts/Counter2.h"]);
        expect(lines[notes + 1]).toBe("  qinit.json  system += QX, QUTIL");
        expect(lines[notes + 2]).toBe("  signer      saved seed (qinit seed)");
        expect(lines[notes + 3]).toBe("  ⚠ version drift");
    });

    test("a status still running is marked as such, and a limit trims the remarks only", () => {
        const lines = renderLines(NOTES.slice(0, 8), 1);

        expect(lines.some((line) => /Counter2\s+31\s+main\s+building…/.test(line))).toBe(true);
        expect(lines.filter((line) => line.includes("QX") || line.includes("QUTIL")).length).toBe(2);
        expect(lines[lines.length - 1]).toBe("  ⚠ version drift");
        expect(lines.some((line) => line.includes("signer"))).toBe(false);
    });

    test("nothing is drawn for a deploy that said nothing", () => {
        expect(renderLines([])).toEqual([]);
    });
});
