import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { QubicSimulator } from "../../src/qubic-simulator";
import { TRACE_STATE_CAP, TraceRecorder } from "../../src/logging/trace";

test("trace metadata keeps the full state size while snapshots stay capped", () => {
  const recorder = new TraceRecorder();
  recorder.setEnabled(true);
  const stateSize = 923_559_560;
  const before = new Uint8Array(TRACE_STATE_CAP);
  const after = before.slice();
  after[TRACE_STATE_CAP - 1] = 1;

  const entry = recorder.begin({
    tick: 0,
    index: 2,
    entry: 0,
    kind: 2,
    invocator: undefined,
    invocationReward: 0n,
    input: new Uint8Array(0),
    stateSize,
    stateBefore: before,
  });
  recorder.end(entry, {
    output: new Uint8Array(0),
    ok: true,
    stateBefore: before,
    stateAfter: after,
    execNs: 1,
  });

  const trace = recorder.trace().entries[0];
  expect(trace.stateSize).toBe(stateSize);
  expect(trace.stateTruncated).toBe(true);
  expect(trace.stateDiff).toEqual([
    {
      off: TRACE_STATE_CAP - 1,
      before: "00",
      after: "01",
    },
  ]);
});

// A poller passes back the last seq it saw, so `since` has to exclude it.
test("trace(since) yields only newer entries, and 1-based seq keeps the first one", () => {
  const recorder = new TraceRecorder();
  recorder.setEnabled(true);
  const record = () =>
    recorder.end(
      recorder.begin({
        tick: 0,
        index: 2,
        entry: 0,
        kind: 2,
        invocator: undefined,
        invocationReward: 0n,
        input: new Uint8Array(0),
        stateSize: 0,
        stateBefore: new Uint8Array(0),
      }),
      {
        output: new Uint8Array(0),
        ok: true,
        stateBefore: new Uint8Array(0),
        stateAfter: new Uint8Array(0),
        execNs: 1,
      },
    );

  for (let i = 0; i < 3; i++) {
    record();
  }

  expect(recorder.trace().entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  expect(recorder.trace(1).entries.map((entry) => entry.seq)).toEqual([2, 3]);
  expect(recorder.trace(3).entries).toEqual([]);

  // The limit keeps the newest entries, and a non-positive one means the whole ring.
  expect(recorder.trace(0, 2).entries.map((entry) => entry.seq)).toEqual([2, 3]);
  expect(recorder.trace(0, 0).entries).toHaveLength(3);
});

test("unmetered runtime tracing snapshots only the trace window", async () => {
  const sim = new QubicSimulator({ fees: "off" });
  const contract = sim.deploy(28, await wasm("Counter"));
  const traced = contract as unknown as { stateSnapshot: (limit: number) => Uint8Array };
  const snapshot = traced.stateSnapshot.bind(contract);
  const limits: number[] = [];
  traced.stateSnapshot = (limit: number) => {
    limits.push(limit);
    return snapshot(limit);
  };

  sim.setDebug(true);
  sim.procedure(28, 1);

  expect(limits).toEqual([TRACE_STATE_CAP, TRACE_STATE_CAP]);
});
