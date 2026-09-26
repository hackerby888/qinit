import type { LogSink } from "@qinit/engine";

// a test run reads assertions: the engine's tick chatter is dropped, a warning or error becomes a note beside the steps.
export function testRunLogSink(note: (line: string) => void): LogSink {
    return (event) => {
        if (event.level === "warn" || event.level === "error") {
            note(`[${event.level}] ${event.cat}: ${event.msg}`);
        }
    };
}
