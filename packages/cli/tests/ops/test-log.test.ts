import { expect, test } from "bun:test";
import { testRunLogSink } from "../../src/ops/test-log";

// the in-process simulator's default sink printed "[debug] tick 2745 tick: tick 2745 end" between the spec's steps.
test("a test run keeps the engine's warnings and errors and drops its tick chatter", () => {
    const notes: string[] = [];
    const sink = testRunLogSink((line) => notes.push(line));

    sink({ level: "debug", tick: 2745, cat: "tick", msg: "tick 2745 end" });
    sink({ level: "info", tick: 2745, cat: "deploy", msg: "slot 29 armed" });
    sink({ level: "warn", tick: 2746, cat: "fee", msg: "reserve exhausted" });
    sink({ level: "error", tick: 2747, cat: "tx", msg: "dropped" });

    expect(notes).toEqual(["[warn] fee: reserve exhausted", "[error] tx: dropped"]);
});
