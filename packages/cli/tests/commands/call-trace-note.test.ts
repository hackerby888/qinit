// a traced call without a frame blamed the debug toggle whatever the cause, which sent three findings the wrong way.
import { expect, test } from "bun:test";
import { missingTraceNote } from "../../src/commands/deploy-interact/call";

test("the toggle is named only when the node says tracing is off", () => {
    expect(missingTraceNote(false, 0)).toContain("debug toggle");
    expect(missingTraceNote(false, 200)).toContain("debug toggle");
});

test("a full poll window is named as the possible cause", () => {
    const note = missingTraceNote(true, 200);

    expect(note).toContain("200 newer frames");
    expect(note).not.toContain("debug toggle");
});

test("tracing on with room left in the window means the call has not run", () => {
    const note = missingTraceNote(true, 199);

    expect(note).toContain("has not run");
    expect(note).not.toContain("debug toggle");
    expect(missingTraceNote(true, 0)).toBe(note);
});
