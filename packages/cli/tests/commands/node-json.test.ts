import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tickJsonResult } from "../../src/commands/node/tick";
import { epochJsonResult } from "../../src/commands/node/epoch";
import { logTail, nodeJsonResult } from "../../src/commands/node/node";

test("tick JSON reports an advance as numbers rather than the rendered arrow", () => {
    const result = tickJsonResult(
        "advance",
        {
            epoch: 2,
            tick: 145,
            fromTick: 120,
            advanced: 25,
            capped: false,
            epochLastTick: 900,
            ticksLeft: null,
            duration: null,
            tickMs: null,
        },
        "",
    );

    expect(result).toEqual({
        ok: true,
        action: "advance",
        epoch: 2,
        tick: 145,
        fromTick: 120,
        advanced: 25,
        capped: false,
        epochLastTick: 900,
        ticksLeft: null,
        duration: null,
        tickMs: null,
        error: null,
    });
});

test("tick JSON keeps the whole key set when the call failed before any facts", () => {
    const result = tickJsonResult("show", null, "node unreachable");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("node unreachable");
    expect(Object.keys(result).sort()).toEqual(
        ["action", "advanced", "capped", "duration", "epoch", "epochLastTick", "error", "fromTick", "ok", "tick", "tickMs", "ticksLeft"].sort(),
    );
});

test("epoch JSON keeps both ends of a transition", () => {
    const result = epochJsonResult(
        "advance",
        {
            epoch: 4,
            fromEpoch: 3,
            toEpoch: 4,
            fromTick: 880,
            tick: 901,
            initialTick: 901,
            epochLastTick: null,
            ticksLeft: null,
            duration: null,
        },
        "",
    );

    expect(result.ok).toBe(true);
    expect(result.fromEpoch).toBe(3);
    expect(result.toEpoch).toBe(4);
    expect(result.fromTick).toBe(880);
    expect(result.initialTick).toBe(901);
    expect(result.error).toBeNull();
});

test("node JSON spreads only the facts its sub-path gathered", () => {
    const status = nodeJsonResult("status", [{ t: "rpc: up, ticking", ok: true }], {
        up: true,
        ticking: true,
        tick: 145,
        contracts: ["Counter"],
    });

    expect(status.ok).toBe(true);
    expect(status).toMatchObject({ action: "status", up: true, contracts: ["Counter"] });
    expect(status.lines).toEqual([{ text: "rpc: up, ticking", ok: true }]);
    // `get` never looks at the chain, so its document carries no tick key at all.
    expect(Object.keys(nodeJsonResult("get", [], { version: "v1", binary: "/n", cached: true }))).not.toContain("tick");
});

test("node JSON fails whenever a line failed, matching the exit status", () => {
    const result = nodeJsonResult("status", [{ t: "rpc: down (node not reachable)", ok: false }], { up: false });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("rpc: down (node not reachable)");
});

test("node JSON says where a down node would be found", () => {
    const result = nodeJsonResult("status", [{ t: "rpc: down (node not reachable)", ok: false }], {
        up: false,
        runtime: "simulator",
        rpc: "http://127.0.0.1:41841",
        pid: null,
        log: "/cache/run/node.log",
    });

    expect(result).toMatchObject({ ok: false, up: false, runtime: "simulator", rpc: "http://127.0.0.1:41841", pid: null, log: "/cache/run/node.log" });
});

test("a log tail is the last lines written, with the byte count a follower resumes from", () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-node-log-"));
    const log = join(directory, "node.log");

    try {
        writeFileSync(log, "boot\ntick 1\ntick 2 ✓\n");

        expect(logTail(log, 2)).toEqual({ lines: ["tick 1", "tick 2 ✓"], bytes: Buffer.byteLength("boot\ntick 1\ntick 2 ✓\n") });
        expect(logTail(log, 50).lines).toEqual(["boot", "tick 1", "tick 2 ✓"]);
        // --lines 0 with --follow prints only what arrives from now on
        expect(logTail(log, 0).lines).toEqual([]);

        writeFileSync(log, "core line\r\nnext\r\n");
        expect(logTail(log, 5).lines).toEqual(["core line", "next"]);

        writeFileSync(log, "half a li");
        expect(logTail(log, 5).lines).toEqual(["half a li"]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
